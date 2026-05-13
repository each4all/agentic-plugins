#!/usr/bin/env node
// Validates repo-local artifact ignore policy for agentic-plugins.
//
// Policy:
//   - .agentic-plugins/config.toml stays trackable for intentional repo-local
//     runtime defaults.
//   - .agentic-plugins/runs/, state/, tmp/, cache/, and *.local.toml are
//     local byproducts and must be ignored by the repository .gitignore.
//   - Legacy host/runtime byproducts (.claude/, .codex/, output/) remain
//     ignored and must not be tracked.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const DEFAULT_REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../..');

export const REQUIRED_IGNORES = [
  {
    pattern: '.agentic-plugins/runs/',
    probe: '.agentic-plugins/runs/context/example/context.json',
    reason: 'runtime context, consensus, doctor, and future run artifacts',
  },
  {
    pattern: '.agentic-plugins/state/',
    probe: '.agentic-plugins/state/engineer/workflows/example.md',
    reason: 'workflow files, archives, peer-run ledgers, locks, and migration manifests',
  },
  {
    pattern: '.agentic-plugins/tmp/',
    probe: '.agentic-plugins/tmp/runtime-probe.json',
    reason: 'temporary operator process byproducts',
  },
  {
    pattern: '.agentic-plugins/cache/',
    probe: '.agentic-plugins/cache/plugin-cache.json',
    reason: 'repo-local runtime caches',
  },
  {
    pattern: '.agentic-plugins/*.local.toml',
    probe: '.agentic-plugins/config.local.toml',
    reason: 'local runtime config overrides',
  },
  {
    pattern: '.claude/',
    probe: '.claude/agentic-engineer/workflows/example.md',
    reason: 'Claude host state and legacy workflow storage',
  },
  {
    pattern: '.codex/',
    probe: '.codex/sessions/example.json',
    reason: 'Codex host state',
  },
  {
    pattern: 'output/',
    probe: 'output/research_brief.md',
    reason: 'legacy plugin test output',
  },
];

export const MUST_NOT_IGNORE = [
  {
    probe: '.agentic-plugins/config.toml',
    reason: 'intentional repo-local runtime defaults must stay trackable',
  },
  {
    probe: 'plugins/runtime/README.md',
    reason: 'source docs must stay trackable',
  },
];

export const DISALLOWED_GITIGNORE_PATTERNS = new Set([
  '.agentic-plugins',
  '.agentic-plugins/',
  '.agentic-plugins/*',
  '/.agentic-plugins',
  '/.agentic-plugins/',
  '/.agentic-plugins/*',
]);

export const DISALLOWED_TRACKED_PREFIXES = [
  '.agentic-plugins/runs/',
  '.agentic-plugins/state/',
  '.agentic-plugins/tmp/',
  '.agentic-plugins/cache/',
  '.claude/',
  '.codex/',
  'output/',
];

export function validateArtifactPolicy(repoRoot = DEFAULT_REPO_ROOT) {
  const resolvedRoot = resolve(repoRoot);
  const errors = [];
  const gitignore = readGitignore(resolvedRoot, errors);
  const patterns = parseGitignorePatterns(gitignore);

  for (const pattern of DISALLOWED_GITIGNORE_PATTERNS) {
    if (patterns.includes(pattern)) {
      errors.push(`.gitignore must not ignore ${pattern}; .agentic-plugins/config.toml must remain trackable`);
    }
  }

  for (const required of REQUIRED_IGNORES) {
    if (!patterns.includes(required.pattern)) {
      errors.push(`.gitignore missing ${required.pattern} (${required.reason})`);
    }
    const check = gitCheckIgnore(resolvedRoot, required.probe);
    if (!check.ignored) {
      errors.push(`git check-ignore did not ignore ${required.probe} (${required.reason})`);
    }
  }

  for (const entry of MUST_NOT_IGNORE) {
    const check = gitCheckIgnore(resolvedRoot, entry.probe);
    if (check.ignored) {
      errors.push(`${entry.probe} must not be ignored (${entry.reason}); matched ${check.source ?? 'unknown source'}`);
    }
  }

  const tracked = gitLsFiles(resolvedRoot, errors);
  for (const path of tracked) {
    if (DISALLOWED_TRACKED_PREFIXES.some((prefix) => path.startsWith(prefix))) {
      errors.push(`tracked generated artifact is not allowed: ${path}`);
    }
    if (/^\.agentic-plugins\/[^/]+\.local\.toml$/.test(path)) {
      errors.push(`tracked local runtime config override is not allowed: ${path}`);
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    checked: {
      required_ignores: REQUIRED_IGNORES.map((entry) => entry.probe),
      must_not_ignore: MUST_NOT_IGNORE.map((entry) => entry.probe),
      tracked_files: tracked.length,
    },
  };
}

function readGitignore(repoRoot, errors) {
  try {
    return readFileSync(resolve(repoRoot, '.gitignore'), 'utf8');
  } catch (err) {
    errors.push(`.gitignore: ${err.message}`);
    return '';
  }
}

function parseGitignorePatterns(text) {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
}

function gitCheckIgnore(repoRoot, path) {
  const result = spawnSync('git', ['check-ignore', '-v', '--', path], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  if (result.status === 0) {
    return {
      ignored: true,
      source: parseCheckIgnoreSource(result.stdout),
      stdout: result.stdout.trim(),
    };
  }
  return {
    ignored: false,
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim(),
  };
}

function parseCheckIgnoreSource(stdout) {
  const line = stdout.split(/\r?\n/).find(Boolean);
  return line?.split('\t')[0] ?? null;
}

function gitLsFiles(repoRoot, errors) {
  const result = spawnSync('git', ['ls-files', '-z'], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    errors.push(`git ls-files failed: ${result.stderr.trim() || result.status}`);
    return [];
  }
  return result.stdout.split('\0').filter(Boolean);
}

function main() {
  const repoRoot = process.argv[2] ? resolve(process.argv[2]) : DEFAULT_REPO_ROOT;
  const report = validateArtifactPolicy(repoRoot);
  if (!report.ok) {
    console.error('Artifact policy validation failed:');
    for (const error of report.errors) console.error(`  - ${error}`);
    process.exit(1);
  }
  console.log('OK — artifact ignore policy is valid');
  console.log(`  required ignores: ${report.checked.required_ignores.length}`);
  console.log(`  tracked files scanned: ${report.checked.tracked_files}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
