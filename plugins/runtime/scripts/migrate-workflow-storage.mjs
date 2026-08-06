#!/usr/bin/env node
// plugins/runtime/scripts/migrate-workflow-storage.mjs
//
// ADR-0025 explicit workflow storage migration. Dry-run is the default.
// Apply mode moves only generated local workflow state from the legacy
// .claude/agentic-* homes into .agentic-plugins/state/<plugin>.

import { spawn } from 'node:child_process';
import { lstat, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { RUNTIME_VERSION } from './version.mjs';

export const MIGRATION_SCHEMA_VERSION = 'workflow-storage-migration-1.0';
export const MIGRATION_ID = 'workflow-storage-v1';

const PLUGIN_SPECS = {
  engineer: {
    plugin: 'engineer',
    legacy_rel: '.claude/agentic-engineer',
    canonical_rel: '.agentic-plugins/state/engineer',
  },
  orchestrator: {
    plugin: 'orchestrator',
    legacy_rel: '.claude/agentic-orchestrator',
    canonical_rel: '.agentic-plugins/state/orchestrator',
  },
};

const TERMINAL_PEER_RUN_STATUSES = new Set(['completed', 'failed', 'cancelled', 'orphaned', 'pruned']);

export async function runWorkflowStorageMigration({
  repoRoot = process.cwd(),
  now = new Date(),
  apply = false,
  plugin = 'all',
  format = 'text',
  runner = defaultRunner,
} = {}) {
  const resolvedRepoRoot = resolve(repoRoot);
  const pluginNames = normalizePluginSelection(plugin);
  const generatedAt = now.toISOString();
  const namespaces = [];
  for (const name of pluginNames) {
    namespaces.push(await inspectNamespace({
      repoRoot: resolvedRepoRoot,
      spec: PLUGIN_SPECS[name],
    }));
  }

  const worktree = await inspectTrackedWorktree({ repoRoot: resolvedRepoRoot, runner });
  const requestedPlugin = String(plugin ?? 'all');
  const preflightBlockers = namespaces.flatMap((namespace) =>
    namespace.blockers.map((blocker) => ({ plugin: namespace.plugin, ...blocker })),
  );
  const movable = namespaces.filter((namespace) => namespace.action === 'move');
  if (apply && requestedPlugin === 'all' && movable.length > 1) {
    preflightBlockers.push({
      plugin: 'all',
      kind: 'multi_namespace_apply_requires_plugin',
      detail: 'apply one namespace at a time with --plugin engineer or --plugin orchestrator to avoid partial multi-namespace migration',
    });
  }
  const existingManifest = await inspectMigrationManifest(resolvedRepoRoot);
  if (apply && ['malformed', 'unreadable'].includes(existingManifest.status)) {
    preflightBlockers.push({
      plugin: 'all',
      kind: existingManifest.status === 'malformed' ? 'migration_manifest_malformed' : 'migration_manifest_unreadable',
      path: existingManifest.path,
      detail: existingManifest.reason,
    });
  }
  let applyStatus = 'not_requested';
  let manifest = null;

  if (apply && preflightBlockers.length > 0) {
    applyStatus = 'blocked';
  } else if (apply && movable.length === 0) {
    applyStatus = 'no_op';
  } else if (apply) {
    for (const namespace of movable) {
      const latest = await inspectNamespace({
        repoRoot: resolvedRepoRoot,
        spec: PLUGIN_SPECS[namespace.plugin],
      });
      if (latest.action !== 'move') {
        const blocker = {
          kind: 'pre_move_recheck_failed',
          detail: 'state changed between dry-run inspection and apply; rerun dry-run before applying',
        };
        namespace.blockers.push(blocker);
        preflightBlockers.push({ plugin: namespace.plugin, ...blocker });
        applyStatus = 'blocked';
        break;
      }
      Object.assign(namespace, latest);
      await moveNamespace(namespace);
      namespace.status = 'applied';
      namespace.applied = true;
      namespace.action = 'moved';
    }
    if (applyStatus !== 'blocked') {
      manifest = await writeMigrationManifest({
        repoRoot: resolvedRepoRoot,
        generatedAt,
        namespaces: movable,
      });
      applyStatus = 'applied';
    }
  }

  const report = {
    schema_version: MIGRATION_SCHEMA_VERSION,
    migration_id: MIGRATION_ID,
    runtime_version: RUNTIME_VERSION,
    generated_at: generatedAt,
    repo_root: resolvedRepoRoot,
    output_format: format,
    dry_run: !apply,
    apply,
    mutation_boundary: {
      writes_allowed: apply
        ? 'generated workflow state rename plus local migration manifest only'
        : 'none; dry-run only',
      allowed_paths: namespaces.flatMap((namespace) => [
        namespace.paths.source,
        namespace.paths.destination,
        join(resolvedRepoRoot, '.agentic-plugins/state/migrations/workflow-storage-v1.json'),
      ]),
      forbidden: [
        'tracked source files',
        'host-native Claude Code or Codex CLI config',
        'authentication state or secrets',
        'sandbox or permission settings',
        'workflow schema or peer-run handle rewrites',
      ],
    },
    worktree,
    namespaces,
    manifest,
    existing_manifest: existingManifest,
    blockers: preflightBlockers,
    apply_status: applyStatus,
  };
  report.overall = summarizeOverall(report);
  return report;
}

function normalizePluginSelection(plugin) {
  const value = String(plugin ?? 'all');
  if (value === 'all') return ['engineer', 'orchestrator'];
  if (PLUGIN_SPECS[value]) return [value];
  throw new Error('--plugin must be all, engineer, or orchestrator');
}

async function inspectNamespace({ repoRoot, spec }) {
  const legacyRoot = join(repoRoot, spec.legacy_rel);
  const canonicalRoot = join(repoRoot, spec.canonical_rel);
  const legacy = await scanHome({ root: legacyRoot, rel: spec.legacy_rel, home: 'legacy', plugin: spec.plugin });
  const canonical = await scanHome({ root: canonicalRoot, rel: spec.canonical_rel, home: 'canonical', plugin: spec.plugin });
  const blockers = buildBlockers({ legacy, canonical });
  const action = decideAction({ legacy, canonical, blockers });
  const status = action === 'move'
    ? 'ready'
    : action === 'blocked'
      ? 'blocked'
      : canonical.has_state
        ? 'canonical'
        : 'empty';
  return {
    plugin: spec.plugin,
    status,
    action,
    applied: false,
    paths: {
      source: legacyRoot,
      destination: canonicalRoot,
    },
    homes: {
      legacy,
      canonical,
    },
    active_workflows_by_branch: {
      legacy: legacy.workflows.by_branch,
      canonical: canonical.workflows.by_branch,
    },
    blockers,
  };
}

function buildBlockers({ legacy, canonical }) {
  const blockers = [];
  if (legacy.has_state && canonical.has_state) {
    const overlap = overlappingBranches(legacy.workflows.by_branch, canonical.workflows.by_branch);
    blockers.push({
      kind: overlap.length > 0 ? 'ambiguous_active_workflows' : 'canonical_state_exists',
      detail: overlap.length > 0
        ? `canonical and legacy homes share branches: ${overlap.join(', ')}`
        : 'canonical state for the same plugin already exists',
    });
  }
  for (const home of [legacy, canonical]) {
    if (home.root_error) {
      blockers.push({
        kind: 'state_home_unreadable',
        home: home.home,
        path: home.root,
        detail: home.root_error,
      });
    }
    if (home.workflows.status === 'blocked' && home.workflows.error) {
      blockers.push({
        kind: 'workflow_directory_unreadable',
        home: home.home,
        path: home.workflows.dir,
        detail: home.workflows.error,
      });
    }
    if (home.archive.status === 'blocked' && home.archive.error) {
      blockers.push({
        kind: 'archive_directory_unreadable',
        home: home.home,
        path: home.archive.dir,
        detail: home.archive.error,
      });
    }
    if (home.peer_runs.status === 'blocked' && home.peer_runs.error) {
      blockers.push({
        kind: 'peer_runs_directory_unreadable',
        home: home.home,
        path: home.peer_runs.dir,
        detail: home.peer_runs.error,
      });
    }
    if (!home.has_state && home.lock_files.length === 0) continue;
    for (const lock of home.lock_files) {
      blockers.push({
        kind: 'lock_file_present',
        home: home.home,
        path: lock.path,
        detail: 'creation or workflow lock must be cleared before migration',
      });
    }
    if (home.peer_runs.non_terminal > 0) {
      blockers.push({
        kind: 'non_terminal_peer_runs',
        home: home.home,
        count: home.peer_runs.non_terminal,
        detail: 'peer-run handles must be terminal before migration',
      });
    }
    if (home.peer_runs.malformed > 0) {
      blockers.push({
        kind: 'malformed_peer_runs',
        home: home.home,
        count: home.peer_runs.malformed,
        detail: 'malformed peer-run handles cannot be proven terminal',
      });
    }
    if (home.workflows.malformed > 0) {
      blockers.push({
        kind: 'malformed_workflows',
        home: home.home,
        count: home.workflows.malformed,
        detail: 'malformed workflow files must be inspected before migration',
      });
    }
  }
  return blockers;
}

function decideAction({ legacy, canonical, blockers }) {
  if (blockers.length > 0) return 'blocked';
  if (legacy.has_state && !canonical.has_state) return 'move';
  return 'none';
}

function overlappingBranches(left, right) {
  return Object.keys(left).filter((branch) => right[branch] > 0).sort();
}

async function scanHome({ root, rel, home, plugin }) {
  const rootInfo = await inspectRoot(root);
  const rootEntries = rootInfo.status === 'directory'
    ? await readDirEntries(root)
    : { exists: rootInfo.exists, entries: [], reason: rootInfo.reason, error: rootInfo.status !== 'missing' };
  const workflows = await scanWorkflowFiles(join(root, 'workflows'));
  const archive = await scanArchiveFiles(join(root, 'archive'));
  const peerRuns = await scanPeerRuns(join(root, 'peer-runs'), plugin);
  const lockFiles = rootEntries.exists ? await findLockFiles(root) : [];
  const hasState = rootEntries.exists && (
    rootEntries.entries.length > 0 ||
    workflows.count > 0 ||
    archive.count > 0 ||
    peerRuns.count > 0 ||
    lockFiles.length > 0
  );
  return {
    home,
    root,
    rel,
    exists: rootEntries.exists,
    root_error: rootEntries.error ? rootEntries.reason : null,
    root_entries: rootEntries.entries,
    has_state: hasState,
    workflows,
    archive,
    peer_runs: peerRuns,
    lock_files: lockFiles,
  };
}

async function inspectRoot(root) {
  try {
    const st = await lstat(root);
    if (st.isSymbolicLink()) {
      return {
        status: 'blocked',
        exists: true,
        reason: 'state home must be a real directory, not a symlink',
      };
    }
    if (!st.isDirectory()) {
      return {
        status: 'blocked',
        exists: true,
        reason: 'state home path exists but is not a directory',
      };
    }
    return { status: 'directory', exists: true, reason: null };
  } catch (err) {
    if (err.code === 'ENOENT') return { status: 'missing', exists: false, reason: 'ENOENT' };
    return { status: 'blocked', exists: false, reason: err.code ?? err.message };
  }
}

async function readDirEntries(dir) {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return {
      exists: true,
      entries: entries.map((entry) => ({
        name: entry.name,
        type: entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'other',
      })),
    };
  } catch (err) {
    if (err.code === 'ENOENT') return { exists: false, entries: [], reason: 'ENOENT' };
    return { exists: false, entries: [], reason: err.code ?? err.message };
  }
}

async function scanWorkflowFiles(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') {
      return { status: 'missing', dir, count: 0, malformed: 0, by_branch: {}, files: [], error: err.code };
    }
    return { status: 'blocked', dir, count: 0, malformed: 0, by_branch: {}, files: [], error: err.code ?? err.message };
  }
  const files = [];
  let malformed = 0;
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
    const path = join(dir, entry.name);
    const text = await readTextIfExists(path);
    const file = { file: entry.name, path, branch: null, status: 'available' };
    if (!text.ok) {
      file.status = 'blocked';
      file.reason = text.reason;
      malformed++;
      files.push(file);
      continue;
    }
    const frontmatter = parseFrontmatterBlock(text.text);
    if (!frontmatter) {
      file.status = 'blocked';
      file.reason = 'missing frontmatter block';
      malformed++;
      files.push(file);
      continue;
    }
    file.branch = extractNestedBranch(frontmatter);
    if (!file.branch) {
      file.status = 'blocked';
      file.reason = 'missing git_baseline.branch';
      malformed++;
    }
    files.push(file);
  }
  return {
    status: malformed > 0 ? 'blocked' : 'available',
    dir,
    count: files.length,
    malformed,
    by_branch: countByBranch(files),
    files,
  };
}

async function scanArchiveFiles(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return { status: 'missing', dir, count: 0, error: err.code };
    return { status: 'blocked', dir, count: 0, error: err.code ?? err.message };
  }
  return {
    status: 'available',
    dir,
    count: entries.filter((entry) => entry.isFile() && entry.name.endsWith('.md')).length,
  };
}

function countByBranch(files) {
  const counts = {};
  for (const file of files) {
    const branch = file.branch || '<unknown>';
    counts[branch] = (counts[branch] ?? 0) + 1;
  }
  return counts;
}

async function scanPeerRuns(dir, plugin) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') {
      return {
        status: 'missing',
        dir,
        count: 0,
        terminal: 0,
        non_terminal: 0,
        malformed: 0,
        runs: [],
        error: err.code,
      };
    }
    return {
      status: 'blocked',
      dir,
      count: 0,
      terminal: 0,
      non_terminal: 0,
      malformed: 0,
      runs: [],
      error: err.code ?? err.message,
    };
  }
  const runs = [];
  let terminal = 0;
  let nonTerminal = 0;
  let malformed = 0;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const handlePath = join(dir, entry.name, 'handle.json');
    const handle = await readJsonIfExists(handlePath);
    if (!handle.ok) {
      malformed++;
      nonTerminal++;
      runs.push({ run_id: entry.name, status: 'blocked', terminal: false, reason: handle.reason });
      continue;
    }
    const status = typeof handle.json.status === 'string' ? handle.json.status : 'unknown';
    const isTerminal = TERMINAL_PEER_RUN_STATUSES.has(status);
    const issues = [];
    if (typeof handle.json.run_id !== 'string' || handle.json.run_id.length === 0) {
      issues.push('missing run_id');
    }
    if (handle.json.plugin !== plugin) {
      issues.push(`plugin mismatch: expected ${plugin}`);
    }
    if (!isTerminal) nonTerminal++;
    else terminal++;
    if (issues.length > 0) malformed++;
    runs.push({
      run_id: handle.json.run_id ?? entry.name,
      status,
      terminal: isTerminal,
      plugin: typeof handle.json.plugin === 'string' ? handle.json.plugin : null,
      issues,
    });
  }
  return {
    status: malformed > 0 || nonTerminal > 0 ? 'blocked' : 'available',
    dir,
    count: runs.length,
    terminal,
    non_terminal: nonTerminal,
    malformed,
    runs,
  };
}

async function findLockFiles(root) {
  const result = [];
  await visit(root);
  return result.sort((a, b) => a.rel.localeCompare(b.rel));

  async function visit(dir) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        await visit(path);
      } else if (entry.isFile() && (entry.name === '.creation-lock' || entry.name.endsWith('.lock'))) {
        result.push({ path, rel: relative(root, path) });
      }
    }
  }
}

async function moveNamespace(namespace) {
  await mkdir(dirname(namespace.paths.destination), { recursive: true });
  if (namespace.homes.canonical.exists && namespace.homes.canonical.root_entries.length === 0) {
    await rm(namespace.paths.destination, { recursive: false });
  }
  await rename(namespace.paths.source, namespace.paths.destination);
}

async function writeMigrationManifest({ repoRoot, generatedAt, namespaces }) {
  const path = migrationManifestPath(repoRoot);
  const existing = await inspectMigrationManifest(repoRoot);
  const existingMigrations = existing.status === 'available' ? existing.manifest.migrations ?? [] : [];
  const nextByPlugin = new Map(existingMigrations.map((entry) => [entry.plugin, entry]));
  for (const namespace of namespaces) {
    nextByPlugin.set(namespace.plugin, namespaceManifestEntry(namespace));
  }
  const migrations = [...nextByPlugin.values()].sort((a, b) => a.plugin.localeCompare(b.plugin));
  const manifest = {
    schema_version: MIGRATION_SCHEMA_VERSION,
    migration_id: MIGRATION_ID,
    runtime_version: RUNTIME_VERSION,
    generated_at: generatedAt,
    plugin_namespaces_migrated: migrations.map((entry) => entry.plugin),
    migrations,
  };
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return { path, manifest };
}

async function inspectMigrationManifest(repoRoot) {
  const path = migrationManifestPath(repoRoot);
  const text = await readTextIfExists(path);
  if (!text.ok) {
    return {
      status: text.reason === 'ENOENT' ? 'missing' : 'unreadable',
      path,
      reason: text.reason,
    };
  }
  try {
    const manifest = JSON.parse(text.text);
    if (
      manifest?.schema_version !== MIGRATION_SCHEMA_VERSION ||
      manifest?.migration_id !== MIGRATION_ID ||
      !Array.isArray(manifest?.migrations)
    ) {
      return { status: 'malformed', path, reason: 'manifest shape does not match workflow-storage-v1' };
    }
    return { status: 'available', path, manifest };
  } catch (err) {
    return { status: 'malformed', path, reason: err.message };
  }
}

function migrationManifestPath(repoRoot) {
  return join(repoRoot, '.agentic-plugins', 'state', 'migrations', 'workflow-storage-v1.json');
}

function namespaceManifestEntry(namespace) {
  return {
    plugin: namespace.plugin,
    source: namespace.paths.source,
    destination: namespace.paths.destination,
    counts: {
      workflows: namespace.homes.legacy.workflows.count,
      archives: namespace.homes.legacy.archive.count,
      peer_runs: namespace.homes.legacy.peer_runs.count,
      non_terminal_peer_runs: namespace.homes.legacy.peer_runs.non_terminal,
      locks: namespace.homes.legacy.lock_files.length,
      active_workflows_by_branch: namespace.homes.legacy.workflows.by_branch,
    },
  };
}

async function inspectTrackedWorktree({ repoRoot, runner }) {
  const result = await runner('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: repoRoot });
  if (!result.ok) {
    return {
      status: 'unknown',
      tracked_dirty: null,
      reason: result.error_code ?? result.stderr ?? 'git status unavailable',
      blocker: false,
    };
  }
  const lines = result.stdout.split(/\r?\n/).filter(Boolean);
  return {
    status: lines.length > 0 ? 'dirty' : 'clean',
    tracked_dirty: lines.length > 0,
    entries: lines,
    blocker: false,
    note: 'Tracked worktree dirtiness is operator awareness only; migration moves ignored local state.',
  };
}

function summarizeOverall(report) {
  if (report.apply_status === 'applied') return { status: 'applied', migrated: report.manifest.manifest.plugin_namespaces_migrated };
  if (report.blockers.length > 0) return { status: 'blocked', blocker_count: report.blockers.length };
  const ready = report.namespaces.filter((namespace) => namespace.action === 'move').map((namespace) => namespace.plugin);
  if (ready.length > 0) return { status: 'ready', ready };
  return { status: 'no_op' };
}

function parseFrontmatterBlock(text) {
  const normalized = String(text ?? '').replace(/\r\n/g, '\n');
  if (!normalized.startsWith('---\n')) return null;
  const end = normalized.indexOf('\n---', 4);
  if (end === -1) return null;
  return normalized.slice(4, end);
}

function extractNestedBranch(frontmatter) {
  const lines = frontmatter.split(/\n/);
  for (let i = 0; i < lines.length; i++) {
    if (!/^git_baseline:\s*$/.test(lines[i])) continue;
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j];
      if (/^\S/.test(line)) break;
      const match = line.match(/^\s+branch:\s*(.*)$/);
      if (match) return unquoteYamlScalar(match[1]);
    }
  }
  const inline = frontmatter.match(/git_baseline:\s*\{[^}]*branch:\s*([^,}]+)[^}]*\}/);
  return inline ? unquoteYamlScalar(inline[1]) : null;
}

function unquoteYamlScalar(value) {
  const text = String(value ?? '').trim();
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
    return text.slice(1, -1);
  }
  return text || null;
}

async function readTextIfExists(path) {
  try {
    return { ok: true, text: await readFile(path, 'utf8') };
  } catch (err) {
    return { ok: false, reason: err.code ?? err.message };
  }
}

async function readJsonIfExists(path) {
  const text = await readTextIfExists(path);
  if (!text.ok) return text;
  try {
    return { ok: true, json: JSON.parse(text.text) };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

async function defaultRunner(command, args, options = {}) {
  return await new Promise((resolvePromise) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', (err) => {
      resolvePromise({ ok: false, exit_code: null, stdout, stderr, error_code: err.code ?? err.message });
    });
    child.on('close', (code) => {
      resolvePromise({ ok: code === 0, exit_code: code, stdout, stderr, error_code: code === 0 ? null : `exit_${code}` });
    });
  });
}

export function formatText(report) {
  const lines = [];
  lines.push(`runtime:migrate workflow-storage ${report.runtime_version} (${report.dry_run ? 'dry-run' : 'apply'})`);
  lines.push(`repo: ${report.repo_root}`);
  lines.push(`overall: ${report.overall.status}`);
  lines.push(`apply-status: ${report.apply_status}`);
  lines.push('');
  lines.push('Mutation Boundary');
  lines.push(`- writes: ${report.mutation_boundary.writes_allowed}`);
  for (const forbidden of report.mutation_boundary.forbidden) lines.push(`- forbidden: ${forbidden}`);
  lines.push('');
  lines.push('Worktree');
  lines.push(`- tracked: ${report.worktree.status}; blocker=false`);
  lines.push('');
  lines.push('Namespaces');
  for (const namespace of report.namespaces) {
    lines.push(`- ${namespace.plugin}: status=${namespace.status}; action=${namespace.action}; applied=${namespace.applied}`);
    lines.push(`  source: ${namespace.paths.source}`);
    lines.push(`  destination: ${namespace.paths.destination}`);
    lines.push(`  legacy: exists=${namespace.homes.legacy.exists}; state=${namespace.homes.legacy.has_state}; workflows=${namespace.homes.legacy.workflows.count}; archives=${namespace.homes.legacy.archive.count}; peer-runs=${namespace.homes.legacy.peer_runs.count}; non-terminal=${namespace.homes.legacy.peer_runs.non_terminal}; locks=${namespace.homes.legacy.lock_files.length}`);
    lines.push(`  canonical: exists=${namespace.homes.canonical.exists}; state=${namespace.homes.canonical.has_state}; workflows=${namespace.homes.canonical.workflows.count}; archives=${namespace.homes.canonical.archive.count}; peer-runs=${namespace.homes.canonical.peer_runs.count}; non-terminal=${namespace.homes.canonical.peer_runs.non_terminal}; locks=${namespace.homes.canonical.lock_files.length}`);
    for (const [branch, count] of Object.entries(namespace.homes.legacy.workflows.by_branch)) {
      lines.push(`  legacy branch: ${branch}=${count}`);
    }
    for (const blocker of namespace.blockers) {
      const path = blocker.path ? ` path=${blocker.path}` : '';
      const count = Number.isInteger(blocker.count) ? ` count=${blocker.count}` : '';
      lines.push(`  blocker: ${blocker.kind};${count}${path} ${blocker.detail}`);
    }
  }
  if (report.manifest) {
    lines.push('');
    lines.push(`Manifest: ${report.manifest.path}`);
  }
  return `${lines.join('\n')}\n`;
}

export function parseArgs(argv) {
  const opts = {
    repoRoot: process.cwd(),
    format: 'text',
    plugin: 'all',
    apply: false,
  };
  const rest = [...argv];
  let sawWorkflowStorage = false;
  if (rest[0] === 'workflow-storage') {
    rest.shift();
    sawWorkflowStorage = true;
  }
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    switch (arg) {
      case 'workflow-storage':
        if (sawWorkflowStorage) throw new Error('workflow-storage subcommand may be supplied only once');
        sawWorkflowStorage = true;
        break;
      case '--repo-root':
        opts.repoRoot = readFlagValue(rest, ++i, '--repo-root');
        break;
      case '--format':
        opts.format = readFlagValue(rest, ++i, '--format');
        break;
      case '--plugin':
        opts.plugin = readFlagValue(rest, ++i, '--plugin');
        break;
      case '--apply':
        opts.apply = true;
        break;
      case '--help':
      case '-h':
        opts.help = true;
        break;
      default:
        throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (!['text', 'json'].includes(opts.format)) throw new Error('--format must be text or json');
  normalizePluginSelection(opts.plugin);
  return opts;
}

function readFlagValue(argv, index, flag) {
  const value = argv[index];
  if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`);
  return value;
}

// `invokedAs` keeps the direct entry point printing its OWN name. The first cut
// hardcoded `migrate.mjs`, so `node migrate-workflow-storage.mjs --help` told
// the operator to run a different file — a compatibility regression on the very
// surface this refactor promised to preserve (cross-host review).
export function workflowStorageUsage(invokedAs = 'migrate.mjs') {
  return [
    `Usage: ${invokedAs} [workflow-storage] [--repo-root <path>]`,
    '  [--format text|json] [--plugin all|engineer|orchestrator] [--apply]',
    '',
    'Dry-run is the default. --apply moves legacy .claude/agentic-* workflow',
    'state into .agentic-plugins/state/<plugin> when no blockers are present.',
  ].join('\n');
}

// The ONE implementation of this subcommand's argv → report → text → exit-code
// contract. `migrate.mjs` dispatches to it and this file keeps its own entry
// point below, so the direct path (`node migrate-workflow-storage.mjs …`) that
// shipped in earlier versions keeps working with identical behavior.
//
// Deliberately NOT re-implemented in the dispatcher: two copies of an
// exit-code rule diverge, and one of them decides whether an APPLY that hit a
// blocker looks like success to a script.
export async function runWorkflowStorageCli(argv, { invokedAs } = {}) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    return { ok: false, reason: err.message, usage: workflowStorageUsage(invokedAs) };
  }
  if (opts.help) return { ok: true, output: workflowStorageUsage(invokedAs), exitCode: 0 };
  const report = await runWorkflowStorageMigration(opts);
  const output = opts.format === 'json' ? `${JSON.stringify(report, null, 2)}` : formatText(report).replace(/\n$/, '');
  const blockedApply = opts.apply && report.overall.status === 'blocked';
  return { ok: true, output, report, exitCode: blockedApply ? 1 : 0 };
}

async function main() {
  const res = await runWorkflowStorageCli(process.argv.slice(2), { invokedAs: 'migrate-workflow-storage.mjs' });
  if (!res.ok) {
    process.stderr.write(`runtime:migrate workflow-storage: ${res.reason}\n`);
    process.stderr.write(`${res.usage}\n`);
    process.exitCode = 1;
    return;
  }
  if (res.output) process.stdout.write(`${res.output}\n`);
  if (res.exitCode) process.exitCode = res.exitCode;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    process.stderr.write(`runtime:migrate workflow-storage failed: ${err.stack ?? err.message}\n`);
    process.exitCode = 1;
  });
}
