#!/usr/bin/env node

import { lstat } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runCommand } from './doctor.mjs';
import { RUNTIME_VERSION } from './version.mjs';

const VERSION = RUNTIME_VERSION;
const SCHEMA_VERSION = 'runtime-worktree-plan-1.0';
const VALID_COMMANDS = new Set(['plan']);
const DEFAULT_BASE_REF = 'origin/main';
const MAX_TIMEOUT_MS = 60000;

export async function runWorktree(options = {}) {
  const command = options.command ?? 'plan';
  if (!VALID_COMMANDS.has(command)) {
    throw new Error(`Unsupported worktree command: ${command}`);
  }
  return buildWorktreePlan(options);
}

export async function buildWorktreePlan(options = {}) {
  const repoRoot = resolve(options.repoRoot ?? process.cwd());
  const now = options.now ?? new Date();
  const runner = options.runner ?? runCommand;
  const timeoutMs = positiveInt(options.timeoutMs ?? 15000, '--timeout-ms', MAX_TIMEOUT_MS);
  const task = options.task ? singleLine(options.task, '--task') : null;
  const baseRef = singleLine(options.baseRef ?? DEFAULT_BASE_REF, '--base');
  const branch = validateBranchName(options.branch ?? deriveBranchName(task));
  const worktreePath = resolve(options.worktreeDir ?? defaultWorktreePath({ repoRoot, branch }));

  const git = await inspectGit({ repoRoot, runner, timeoutMs, baseRef, branch, worktreePath });
  const criteria = buildCriteria({ git });
  const recommendation = buildRecommendation({ git, criteria });
  return {
    schema_version: SCHEMA_VERSION,
    runtime_version: VERSION,
    command: 'plan',
    generated_at: now.toISOString(),
    repo_root: repoRoot,
    output_format: options.format ?? 'text',
    dry_run: true,
    mutation_boundary: {
      writes_allowed: 'none; read-only worktree planning only',
      forbidden: [
        'git branch creation',
        'git worktree add/remove/prune',
        'tracked source edits',
        'host-native config/auth/secrets/sandbox changes',
      ],
    },
    request: {
      task,
      base_ref: baseRef,
      branch,
      worktree_path: worktreePath,
    },
    git,
    criteria,
    recommendation,
    limits: [
      'This command never creates branches, worktrees, commits, or pull requests.',
      'Suggested commands are operator guidance only and must be run explicitly outside runtime:worktree.',
      'Worktree planning does not replace feature PR validation or release-package scoping.',
    ],
    overall: {
      status: recommendation.blocked ? 'blocked' : 'pass',
      should_use_worktree: recommendation.should_use_worktree,
      blocked: recommendation.blocked,
    },
  };
}

async function inspectGit({ repoRoot, runner, timeoutMs, baseRef, branch, worktreePath }) {
  const gitAvailable = await runGit({ repoRoot, runner, timeoutMs, args: ['--version'] });
  if (!gitAvailable.ok) {
    return {
      status: 'unavailable',
      git_available: false,
      reason: gitAvailable.error_code ?? `git exited ${gitAvailable.exit_code}`,
      current: null,
      base: null,
      branch: null,
      worktree_path: await inspectPath(worktreePath),
      worktrees: [],
    };
  }

  const topLevel = await runGit({ repoRoot, runner, timeoutMs, args: ['rev-parse', '--show-toplevel'] });
  if (!topLevel.ok) {
    return {
      status: 'not_git_repo',
      git_available: true,
      reason: firstLine(topLevel.stderr) || topLevel.error_code || `git exited ${topLevel.exit_code}`,
      current: null,
      base: null,
      branch: null,
      worktree_path: await inspectPath(worktreePath),
      worktrees: [],
    };
  }

  const resolvedRoot = firstLine(topLevel.stdout) || repoRoot;
  const [head, branchName, statusShort, porcelain, base, branchRef, worktreesRaw, pathInfo] = await Promise.all([
    runGit({ repoRoot, runner, timeoutMs, args: ['rev-parse', 'HEAD'] }),
    runGit({ repoRoot, runner, timeoutMs, args: ['rev-parse', '--abbrev-ref', 'HEAD'] }),
    runGit({ repoRoot, runner, timeoutMs, args: ['status', '--short', '--branch'] }),
    runGit({ repoRoot, runner, timeoutMs, args: ['status', '--porcelain=v1'] }),
    runGit({ repoRoot, runner, timeoutMs, args: ['rev-parse', '--verify', baseRef] }),
    runGit({ repoRoot, runner, timeoutMs, args: ['show-ref', '--verify', `refs/heads/${branch}`] }),
    runGit({ repoRoot, runner, timeoutMs, args: ['worktree', 'list', '--porcelain'] }),
    inspectPath(worktreePath),
  ]);

  const currentBranch = firstLine(branchName.stdout);
  const isDetached = currentBranch === 'HEAD';
  const dirtyLines = splitLines(porcelain.stdout);
  const worktrees = worktreesRaw.ok ? parseWorktreePorcelain(worktreesRaw.stdout) : [];
  return {
    status: 'available',
    git_available: true,
    top_level: resolvedRoot,
    current: {
      branch: isDetached ? null : currentBranch,
      detached: isDetached,
      head: head.ok ? firstLine(head.stdout) : null,
      dirty: dirtyLines.length > 0,
      dirty_count: dirtyLines.length,
      status_short: splitLines(statusShort.stdout),
    },
    base: {
      ref: baseRef,
      status: base.ok ? 'resolved' : 'unresolved',
      head: base.ok ? firstLine(base.stdout) : null,
      reason: base.ok ? null : firstLine(base.stderr) || base.error_code || `git exited ${base.exit_code}`,
    },
    branch: {
      name: branch,
      status: branchRef.ok ? 'exists' : 'available',
      reason: branchRef.ok ? 'local branch already exists' : null,
    },
    worktree_path: pathInfo,
    worktrees,
    worktree_count: worktrees.length,
  };
}

function buildCriteria({ git }) {
  const criteria = [];
  criteria.push(criterion('git_repo', git.status === 'available' ? 'pass' : 'fail', git.reason ?? 'git repository detected'));
  if (git.status !== 'available') return criteria;
  criteria.push(criterion('base_ref', git.base.status === 'resolved' ? 'pass' : 'fail', git.base.reason ?? `base ${git.base.ref} resolves`));
  criteria.push(criterion('branch_available', git.branch.status === 'available' ? 'pass' : 'fail', git.branch.reason ?? `branch ${git.branch.name} is available`));
  criteria.push(criterion('worktree_path_available', git.worktree_path.status === 'available' ? 'pass' : 'fail', git.worktree_path.reason ?? 'suggested worktree path is available'));
  criteria.push(criterion('current_worktree_clean', git.current.dirty ? 'warn' : 'pass', git.current.dirty ? `${git.current.dirty_count} uncommitted change(s) detected` : 'current worktree is clean'));
  criteria.push(criterion('current_branch', git.current.detached ? 'warn' : 'pass', git.current.detached ? 'current checkout is detached' : `current branch is ${git.current.branch}`));
  return criteria;
}

function buildRecommendation({ git, criteria }) {
  const failed = criteria.filter((item) => item.status === 'fail');
  if (git.status !== 'available' || failed.some((item) => ['git_repo', 'base_ref', 'branch_available', 'worktree_path_available'].includes(item.name))) {
    return {
      should_use_worktree: false,
      blocked: true,
      action: 'fix-blockers',
      reason: failed.map((item) => `${item.name}: ${item.detail}`).join('; '),
      commands: [],
      next_steps: [
        'Resolve the failed criteria, then rerun runtime:worktree plan.',
      ],
    };
  }

  const shouldUseWorktree = git.current.detached || git.current.dirty || git.current.branch === 'main' || git.current.branch === 'master' || git.worktree_count > 1;
  const addCommand = `git worktree add -b ${git.branch.name} ${quoteShell(git.worktree_path.path)} ${git.base.ref}`;
  return {
    should_use_worktree: shouldUseWorktree,
    blocked: false,
    action: shouldUseWorktree ? 'create-dedicated-worktree' : 'optional-dedicated-worktree',
    reason: shouldUseWorktree
      ? 'Use a dedicated worktree for the next non-trivial slice so current branch state, context artifacts, and release follow-up stay isolated.'
      : 'Current checkout is clean and already on a non-default branch; a worktree is optional but still useful for parallel investigation.',
    commands: [
      {
        label: 'create_worktree',
        command: addCommand,
        argv: ['git', 'worktree', 'add', '-b', git.branch.name, git.worktree_path.path, git.base.ref],
        mutates_git_state: true,
        execute: false,
      },
      {
        label: 'enter_worktree',
        command: `cd ${quoteShell(git.worktree_path.path)}`,
        argv: ['cd', git.worktree_path.path],
        mutates_git_state: false,
        execute: false,
      },
    ],
    next_steps: [
      'Run the suggested git worktree command only if the operator accepts the plan.',
      'Start the next runtime slice inside the dedicated worktree and keep feature/release PR handling scoped to that checkout.',
    ],
  };
}

function criterion(name, status, detail) {
  return { name, status, detail };
}

async function inspectPath(path) {
  try {
    await lstat(path);
    return { path, status: 'exists', reason: 'path already exists' };
  } catch (error) {
    if (error.code === 'ENOENT') return { path, status: 'available', reason: null };
    return { path, status: 'blocked', reason: error.code ?? error.message };
  }
}

function parseWorktreePorcelain(text) {
  const entries = [];
  let current = null;
  for (const line of splitLines(text)) {
    if (line.startsWith('worktree ')) {
      if (current) entries.push(current);
      current = {
        path: line.slice('worktree '.length),
        head: null,
        branch: null,
        detached: false,
        bare: false,
      };
      continue;
    }
    if (!current) continue;
    if (line.startsWith('HEAD ')) current.head = line.slice('HEAD '.length);
    else if (line.startsWith('branch ')) current.branch = line.slice('branch refs/heads/'.length);
    else if (line === 'detached') current.detached = true;
    else if (line === 'bare') current.bare = true;
  }
  if (current) entries.push(current);
  return entries;
}

async function runGit({ repoRoot, runner, timeoutMs, args }) {
  return runner('git', args, { cwd: repoRoot, timeoutMs });
}

export function parseArgs(argv) {
  const args = [...argv];
  let command = null;
  if (args[0] && !args[0].startsWith('-')) {
    command = args.shift();
    if (!VALID_COMMANDS.has(command)) {
      throw new Error(`Command must be one of: ${[...VALID_COMMANDS].join(', ')}`);
    }
  }
  const options = {};
  while (args.length > 0) {
    const arg = args.shift();
    if (!arg.startsWith('-')) {
      if (!command && VALID_COMMANDS.has(arg)) {
        command = arg;
        continue;
      }
      throw new Error(`Command must be one of: ${[...VALID_COMMANDS].join(', ')}`);
    }
    switch (arg) {
      case '--repo-root':
        options.repoRoot = requireValue(args, arg);
        break;
      case '--format': {
        const format = requireValue(args, arg);
        if (!['text', 'json'].includes(format)) throw new Error('--format must be text or json');
        options.format = format;
        break;
      }
      case '--task':
        options.task = requireValue(args, arg);
        break;
      case '--branch':
        options.branch = validateBranchName(requireValue(args, arg));
        break;
      case '--base':
      case '--base-ref':
        options.baseRef = requireValue(args, arg);
        break;
      case '--worktree-dir':
        options.worktreeDir = requireValue(args, arg);
        break;
      case '--timeout-ms':
        options.timeoutMs = positiveInt(requireValue(args, arg), arg, MAX_TIMEOUT_MS);
        break;
      case '--help':
        options.help = true;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }
  options.command = command ?? 'plan';
  return options;
}

export function formatText(report) {
  if (report.help) return helpText();
  const lines = [`runtime:worktree ${report.runtime_version ?? VERSION} (${report.command})`];
  lines.push(`status: ${report.overall.status}`);
  lines.push(`should use worktree: ${report.overall.should_use_worktree}`);
  if (report.git?.current) {
    lines.push(`current: branch=${report.git.current.branch ?? '<detached>'}; dirty=${report.git.current.dirty}; dirty-count=${report.git.current.dirty_count}`);
  }
  if (report.request) {
    lines.push(`planned branch: ${report.request.branch}`);
    lines.push(`planned path: ${report.request.worktree_path}`);
    lines.push(`base ref: ${report.request.base_ref}`);
  }
  if (report.criteria?.length) {
    lines.push('', 'criteria:');
    for (const item of report.criteria) lines.push(`- ${item.name}: ${item.status}; ${item.detail}`);
  }
  if (report.recommendation) {
    lines.push('', `recommendation: ${report.recommendation.action}`);
    lines.push(`reason: ${report.recommendation.reason}`);
  }
  if (report.recommendation?.commands?.length) {
    lines.push('', 'suggested commands (not executed):');
    for (const command of report.recommendation.commands) lines.push(`- ${command.command}`);
  }
  if (report.recommendation?.next_steps?.length) {
    lines.push('', 'next steps:');
    for (const step of report.recommendation.next_steps) lines.push(`- ${step}`);
  }
  if (report.limits?.length) {
    lines.push('', 'limits:');
    for (const limit of report.limits) lines.push(`- ${limit}`);
  }
  return lines.join('\n');
}

function helpText() {
  return `runtime:worktree ${VERSION}

Usage:
  runtime:worktree plan [--task <text>] [--branch <name>] [--base <ref>] [--worktree-dir <path>] [--format text|json]

Plans a dedicated git worktree for the next runtime/operator slice. This command is read-only and never runs git worktree add, branch creation, commit, push, or PR operations.`;
}

function deriveBranchName(task) {
  const slug = slugify(task || 'runtime-worktree-slice');
  return `feat/${slug}`;
}

function defaultWorktreePath({ repoRoot, branch }) {
  const slug = branch.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'runtime-worktree';
  return resolve(dirname(repoRoot), `${basename(repoRoot)}-${slug}`);
}

function slugify(value) {
  const slug = String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/g, '');
  return slug || 'runtime-worktree-slice';
}

function validateBranchName(value) {
  const branch = singleLine(value, '--branch');
  if (
    branch.startsWith('/') ||
    branch.endsWith('/') ||
    branch.includes('..') ||
    branch.includes('@{') ||
    branch.includes('\\') ||
    branch.endsWith('.lock') ||
    !/^[A-Za-z0-9._/-]+$/.test(branch)
  ) {
    throw new Error('--branch must be a simple git branch name without traversal, spaces, or ref metacharacters');
  }
  return branch;
}

function singleLine(value, label) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (!text) throw new Error(`${label} must not be empty`);
  return text;
}

function positiveInt(value, label, max = Number.MAX_SAFE_INTEGER) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) throw new Error(`${label} must be a positive integer`);
  if (number > max) throw new Error(`${label} must be <= ${max}`);
  return number;
}

function requireValue(args, flag) {
  if (args.length === 0 || args[0].startsWith('-')) throw new Error(`${flag} requires a value`);
  return args.shift();
}

function firstLine(text) {
  return splitLines(text)[0] ?? '';
}

function splitLines(text) {
  return String(text ?? '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

function quoteShell(value) {
  const text = String(value);
  if (/^[A-Za-z0-9_./:-]+$/.test(text)) return text;
  return `'${text.replace(/'/g, "'\\''")}'`;
}

async function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
      console.log(helpText());
      return;
    }
    const report = await runWorktree(options);
    if (options.format === 'json') console.log(JSON.stringify(report, null, 2));
    else console.log(formatText(report));
  } catch (error) {
    console.error(`runtime:worktree: ${error.message}`);
    process.exitCode = 1;
  }
}

const isDirect = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirect) {
  await main();
}
