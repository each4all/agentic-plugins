// Tests for scripts/validate-artifacts.mjs.
//
// Each test creates a small git repo because the validator intentionally uses
// git check-ignore and git ls-files rather than a home-grown ignore parser.

import { describe, it, beforeEach, afterEach } from 'node:test';
import { ok, strictEqual } from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

import { validateArtifactPolicy } from '../../scripts/validate-artifacts.mjs';

let repoRoot;

describe('validate-artifacts', () => {
  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'validate-artifacts-test-'));
    git('init', '-q');
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  it('accepts the intended artifact policy while leaving config.toml trackable', () => {
    writeGitignore(defaultGitignore());
    writeSourceFile('plugins/runtime/README.md', '# runtime\n');

    const report = validateArtifactPolicy(repoRoot);

    strictEqual(report.ok, true);
    strictEqual(report.errors.length, 0);
  });

  it('rejects missing repo-level ignore coverage for generated runs', () => {
    writeGitignore(defaultGitignore().replace('.agentic-plugins/runs/\n', ''));
    writeSourceFile('plugins/runtime/README.md', '# runtime\n');

    const report = validateArtifactPolicy(repoRoot);

    strictEqual(report.ok, false);
    ok(report.errors.some((error) => error.includes('.gitignore missing .agentic-plugins/runs/')));
    ok(report.errors.some((error) => error.includes('git check-ignore did not ignore .agentic-plugins/runs/context/example/context.json')));
  });

  it('rejects missing repo-level ignore coverage for generated workflow state', () => {
    writeGitignore(defaultGitignore().replace('.agentic-plugins/state/\n', ''));
    writeSourceFile('plugins/runtime/README.md', '# runtime\n');

    const report = validateArtifactPolicy(repoRoot);

    strictEqual(report.ok, false);
    ok(report.errors.some((error) => error.includes('.gitignore missing .agentic-plugins/state/')));
    ok(report.errors.some((error) => error.includes('git check-ignore did not ignore .agentic-plugins/state/engineer/workflows/example.md')));
  });

  it('rejects broad .agentic-plugins ignores that would hide config.toml', () => {
    writeGitignore(`${defaultGitignore()}.agentic-plugins/\n`);
    writeSourceFile('plugins/runtime/README.md', '# runtime\n');

    const report = validateArtifactPolicy(repoRoot);

    strictEqual(report.ok, false);
    ok(report.errors.some((error) => error.includes('must not ignore .agentic-plugins/')));
    ok(report.errors.some((error) => error.includes('.agentic-plugins/config.toml must not be ignored')));
  });

  it('rejects tracked generated artifacts even when they are ignored', () => {
    writeGitignore(defaultGitignore());
    writeSourceFile('plugins/runtime/README.md', '# runtime\n');
    writeSourceFile('.agentic-plugins/state/engineer/workflows/wf.md', 'local state\n');
    git('add', '-f', '.agentic-plugins/state/engineer/workflows/wf.md');

    const report = validateArtifactPolicy(repoRoot);

    strictEqual(report.ok, false);
    ok(report.errors.some((error) => error.includes('tracked generated artifact is not allowed: .agentic-plugins/state/engineer/workflows/wf.md')));
  });
});

function defaultGitignore() {
  return [
    '.claude/',
    '.codex/',
    '.agentic-plugins/runs/',
    '.agentic-plugins/state/',
    '.agentic-plugins/tmp/',
    '.agentic-plugins/cache/',
    '.agentic-plugins/*.local.toml',
    'output/',
    '',
  ].join('\n');
}

function writeGitignore(text) {
  writeFileSync(resolve(repoRoot, '.gitignore'), text);
}

function writeSourceFile(path, text) {
  const abs = resolve(repoRoot, path);
  mkdirSync(resolve(abs, '..'), { recursive: true });
  writeFileSync(abs, text);
}

function git(...args) {
  const result = spawnSync('git', args, {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
  }
  return result;
}
