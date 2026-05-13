import { describe, it } from 'node:test';
import { deepStrictEqual, ok, rejects, strictEqual } from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  formatText,
  parseArgs,
  runWorkflowStorageMigration,
} from '../../plugins/runtime/scripts/migrate-workflow-storage.mjs';

describe('runtime migrate workflow-storage', () => {
  it('builds a dry-run migration plan without moving legacy state', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-migrate-dry-run-'));
    await writeWorkflow(
      join(root, '.claude', 'agentic-engineer', 'workflows', 'compose-20260514T000000Z-aaaaaa.md'),
      'feat/migrate',
    );
    await writePeerHandle(join(root, '.claude', 'agentic-engineer', 'peer-runs', 'done-run'), {
      run_id: 'done-run',
      plugin: 'engineer',
      status: 'completed',
    });

    const report = await runWorkflowStorageMigration({
      repoRoot: root,
      plugin: 'engineer',
      now: new Date('2026-05-14T00:00:00.000Z'),
      runner: cleanGitRunner,
    });

    strictEqual(report.dry_run, true);
    strictEqual(report.overall.status, 'ready');
    strictEqual(report.namespaces[0].status, 'ready');
    strictEqual(report.namespaces[0].action, 'move');
    deepStrictEqual(report.namespaces[0].active_workflows_by_branch.legacy, { 'feat/migrate': 1 });
    await stat(join(root, '.claude', 'agentic-engineer', 'workflows', 'compose-20260514T000000Z-aaaaaa.md'));
    await rejects(() => stat(join(root, '.agentic-plugins', 'state', 'engineer')), /ENOENT/);
    ok(formatText(report).includes('runtime:migrate workflow-storage'));
  });

  it('applies migration by moving the legacy namespace and writing a manifest', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-migrate-apply-'));
    await writeWorkflow(
      join(root, '.claude', 'agentic-engineer', 'workflows', 'compose-20260514T000000Z-bbbbbb.md'),
      'feat/apply',
    );
    await writeWorkflow(
      join(root, '.claude', 'agentic-engineer', 'archive', 'compose-20260513T000000Z-cccccc.md'),
      'feat/done',
    );
    await writePeerHandle(join(root, '.claude', 'agentic-engineer', 'peer-runs', 'done-run'), {
      run_id: 'done-run',
      plugin: 'engineer',
      status: 'completed',
    });

    const report = await runWorkflowStorageMigration({
      repoRoot: root,
      plugin: 'engineer',
      apply: true,
      now: new Date('2026-05-14T00:00:00.000Z'),
      runner: cleanGitRunner,
    });

    strictEqual(report.overall.status, 'applied');
    strictEqual(report.apply_status, 'applied');
    strictEqual(report.namespaces[0].applied, true);
    await stat(join(root, '.agentic-plugins', 'state', 'engineer', 'workflows', 'compose-20260514T000000Z-bbbbbb.md'));
    await stat(join(root, '.agentic-plugins', 'state', 'engineer', 'archive', 'compose-20260513T000000Z-cccccc.md'));
    await stat(join(root, '.agentic-plugins', 'state', 'engineer', 'peer-runs', 'done-run', 'handle.json'));
    await rejects(() => stat(join(root, '.claude', 'agentic-engineer')), /ENOENT/);

    const manifestText = await readFile(join(root, '.agentic-plugins', 'state', 'migrations', 'workflow-storage-v1.json'), 'utf8');
    const manifest = JSON.parse(manifestText);
    deepStrictEqual(manifest.plugin_namespaces_migrated, ['engineer']);
    strictEqual(manifest.migrations[0].counts.workflows, 1);
    strictEqual(manifest.migrations[0].counts.archives, 1);
    strictEqual(manifest.migrations[0].counts.peer_runs, 1);
  });

  it('blocks apply when canonical state already exists', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-migrate-canonical-block-'));
    await writeWorkflow(
      join(root, '.claude', 'agentic-engineer', 'workflows', 'compose-20260514T000000Z-dddddd.md'),
      'feat/shared',
    );
    await writeWorkflow(
      join(root, '.agentic-plugins', 'state', 'engineer', 'workflows', 'compose-20260514T000001Z-eeeeee.md'),
      'feat/shared',
    );

    const report = await runWorkflowStorageMigration({
      repoRoot: root,
      plugin: 'engineer',
      apply: true,
      runner: cleanGitRunner,
    });

    strictEqual(report.overall.status, 'blocked');
    strictEqual(report.apply_status, 'blocked');
    ok(report.blockers.some((blocker) => blocker.kind === 'ambiguous_active_workflows'));
    await stat(join(root, '.claude', 'agentic-engineer', 'workflows', 'compose-20260514T000000Z-dddddd.md'));
  });

  it('blocks apply when a peer-run handle is non-terminal', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-migrate-peer-block-'));
    await writeWorkflow(
      join(root, '.claude', 'agentic-orchestrator', 'workflows', 'macro-compose-20260514T000000Z-ffffff.md'),
      'feat/macro',
    );
    await writePeerHandle(join(root, '.claude', 'agentic-orchestrator', 'peer-runs', 'running-run'), {
      run_id: 'running-run',
      plugin: 'orchestrator',
      status: 'running',
      updated_at: '2026-05-14T00:00:00.000Z',
    });

    const report = await runWorkflowStorageMigration({
      repoRoot: root,
      plugin: 'orchestrator',
      apply: true,
      runner: cleanGitRunner,
    });

    strictEqual(report.overall.status, 'blocked');
    ok(report.blockers.some((blocker) => blocker.kind === 'non_terminal_peer_runs'));
    await stat(join(root, '.claude', 'agentic-orchestrator', 'peer-runs', 'running-run', 'handle.json'));
  });

  it('blocks multi-namespace apply to avoid partial migration', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-migrate-all-block-'));
    await writeWorkflow(
      join(root, '.claude', 'agentic-engineer', 'workflows', 'compose-20260514T000000Z-aaaaaa.md'),
      'feat/engineer',
    );
    await writeWorkflow(
      join(root, '.claude', 'agentic-orchestrator', 'workflows', 'macro-compose-20260514T000000Z-bbbbbb.md'),
      'feat/orchestrator',
    );

    const report = await runWorkflowStorageMigration({
      repoRoot: root,
      apply: true,
      runner: cleanGitRunner,
    });

    strictEqual(report.overall.status, 'blocked');
    ok(report.blockers.some((blocker) => blocker.kind === 'multi_namespace_apply_requires_plugin'));
    await stat(join(root, '.claude', 'agentic-engineer'));
    await stat(join(root, '.claude', 'agentic-orchestrator'));
  });

  it('blocks apply when workflow branch metadata cannot be read', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-migrate-missing-branch-'));
    await writeMalformedWorkflow(
      join(root, '.claude', 'agentic-engineer', 'workflows', 'compose-20260514T000000Z-aaaaaa.md'),
    );

    const report = await runWorkflowStorageMigration({
      repoRoot: root,
      plugin: 'engineer',
      apply: true,
      runner: cleanGitRunner,
    });

    strictEqual(report.overall.status, 'blocked');
    ok(report.blockers.some((blocker) => blocker.kind === 'malformed_workflows'));
    await stat(join(root, '.claude', 'agentic-engineer', 'workflows', 'compose-20260514T000000Z-aaaaaa.md'));
  });

  it('blocks apply when a workflow path is not readable as a directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-migrate-workflows-file-'));
    await mkdir(join(root, '.claude', 'agentic-engineer'), { recursive: true });
    await writeFile(join(root, '.claude', 'agentic-engineer', 'workflows'), 'not a directory\n');

    const report = await runWorkflowStorageMigration({
      repoRoot: root,
      plugin: 'engineer',
      apply: true,
      runner: cleanGitRunner,
    });

    strictEqual(report.overall.status, 'blocked');
    ok(report.blockers.some((blocker) => blocker.kind === 'workflow_directory_unreadable'));
    await stat(join(root, '.claude', 'agentic-engineer', 'workflows'));
  });

  it('preserves prior namespace entries when writing the migration manifest', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-migrate-manifest-merge-'));
    await writeWorkflow(
      join(root, '.claude', 'agentic-engineer', 'workflows', 'compose-20260514T000000Z-aaaaaa.md'),
      'feat/engineer',
    );
    await writeWorkflow(
      join(root, '.claude', 'agentic-orchestrator', 'workflows', 'macro-compose-20260514T000000Z-bbbbbb.md'),
      'feat/orchestrator',
    );

    await runWorkflowStorageMigration({
      repoRoot: root,
      plugin: 'engineer',
      apply: true,
      runner: cleanGitRunner,
    });
    await runWorkflowStorageMigration({
      repoRoot: root,
      plugin: 'orchestrator',
      apply: true,
      runner: cleanGitRunner,
    });

    const manifestText = await readFile(join(root, '.agentic-plugins', 'state', 'migrations', 'workflow-storage-v1.json'), 'utf8');
    const manifest = JSON.parse(manifestText);
    deepStrictEqual(manifest.plugin_namespaces_migrated, ['engineer', 'orchestrator']);
  });

  it('parses CLI arguments', async () => {
    const opts = parseArgs([
      '--repo-root',
      '/tmp/repo',
      'workflow-storage',
      '--format',
      'json',
      '--plugin',
      'orchestrator',
      '--apply',
    ]);
    strictEqual(opts.repoRoot, '/tmp/repo');
    strictEqual(opts.format, 'json');
    strictEqual(opts.plugin, 'orchestrator');
    strictEqual(opts.apply, true);
    await rejects(async () => parseArgs(['--plugin']), /--plugin requires a value/);
    await rejects(async () => parseArgs(['workflow-storage', 'workflow-storage']), /workflow-storage subcommand may be supplied only once/);
  });
});

async function writeWorkflow(path, branch) {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, [
    '---',
    'schema: "1.0"',
    'workflow_id: "workflow-test"',
    'current_phase: "compose"',
    'git_baseline:',
    `  branch: "${branch}"`,
    '---',
    '',
    '# Workflow',
    '',
  ].join('\n'), 'utf8');
}

async function writeMalformedWorkflow(path) {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, [
    '---',
    'schema: "1.0"',
    'workflow_id: "workflow-test"',
    'current_phase: "compose"',
    '---',
    '',
    '# Workflow',
    '',
  ].join('\n'), 'utf8');
}

async function writePeerHandle(path, handle) {
  await mkdir(path, { recursive: true });
  await writeFile(join(path, 'handle.json'), `${JSON.stringify(handle, null, 2)}\n`, 'utf8');
}

async function cleanGitRunner() {
  return { ok: true, exit_code: 0, stdout: '', stderr: '', error_code: null };
}
