import { describe, it } from 'node:test';
import { deepStrictEqual, ok, strictEqual, rejects } from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  extractBaselineVersions,
  formatText,
  parseArgs,
  runCompat,
} from '../../plugins/runtime/scripts/compat.mjs';

const RUN_ID = 'compat-20260516T000000Z-abcdef';

describe('runtime compat', () => {
  it('records host versions, help hashes, plugin versions, and latest pointer', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-compat-snapshot-'));
    await writeFile(join(root, '.release-please-manifest.json'), JSON.stringify({
      'plugins/runtime': '0.31.9',
      'plugins/engineer': '0.10.2',
    }));
    const report = await runCompat({
      command: 'snapshot',
      repoRoot: root,
      runId: RUN_ID,
      now: new Date('2026-05-16T00:00:00.000Z'),
      baseline: baseline(),
      runner: fakeRunner({
        claude: '2.1.141 (Claude Code)',
        codex: 'codex-cli 0.130.0',
      }),
    });

    strictEqual(report.command, 'snapshot');
    strictEqual(report.run_id, RUN_ID);
    strictEqual(report.hosts.claude.version, '2.1.141');
    strictEqual(report.hosts.codex.version, '0.130.0');
    strictEqual(report.snapshot_pointer, `.agentic-plugins/runs/compat/${RUN_ID}/snapshot.json`);
    ok(report.next_steps.includes(`runtime:compat check --run-id ${RUN_ID}`));

    const snapshot = await readJson(join(root, report.snapshot_pointer));
    strictEqual(snapshot.schema_version, 'runtime-compat-snapshot-1.0');
    strictEqual(snapshot.hosts.claude.probes.help.stdout_bytes > 0, true);
    strictEqual(snapshot.hosts.claude.probes.help.stdout_sha256.length, 64);
    strictEqual(snapshot.plugin_versions['plugins/runtime'], '0.31.9');
    const latest = await readJson(join(root, '.agentic-plugins/runs/compat/latest.json'));
    strictEqual(latest.run_id, RUN_ID);
  });

  it('checks a snapshot against the remembered baseline and requires release notes on drift', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-compat-check-'));
    await runCompat({
      command: 'snapshot',
      repoRoot: root,
      runId: RUN_ID,
      now: new Date('2026-05-16T00:00:00.000Z'),
      baseline: baseline(),
      runner: fakeRunner({
        claude: '2.1.150 (Claude Code)',
        codex: 'codex-cli 0.130.0',
      }),
    });

    const report = await runCompat({
      command: 'check',
      repoRoot: root,
      runId: RUN_ID,
      baseline: baseline(),
      now: new Date('2026-05-16T00:01:00.000Z'),
    });

    strictEqual(report.status, 'release_notes_required');
    strictEqual(report.drift_class, 'host-version-changed');
    strictEqual(report.release_notes_required, true);
    strictEqual(report.host_gaps.find((gap) => gap.host === 'claude').status, 'version_changed');
    strictEqual(report.host_gaps.find((gap) => gap.host === 'codex').status, 'matches');
    ok(formatText(report).includes('release_notes_required'));

    const gap = await readJson(join(root, report.gap_pointer));
    strictEqual(gap.schema_version, 'runtime-compat-gap-1.0');
    strictEqual(gap.next_steps[0], `runtime:compat ingest-release-notes --run-id ${RUN_ID} --release-notes-file <path> or --release-notes-url <url> --fetch-release-notes-url`);
  });

  it('ingests explicit release-note files and plans affected compatibility surfaces', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-compat-plan-'));
    const notePath = join(root, 'release-notes.md');
    await writeFile(notePath, [
      'Claude Code 2.1.150',
      'Plugin hooks now include additional Stop payload fields.',
      'Model and permission behavior changed for subagents.',
      '',
    ].join('\n'));
    await runCompat({
      command: 'snapshot',
      repoRoot: root,
      runId: RUN_ID,
      baseline: baseline(),
      runner: fakeRunner({
        claude: '2.1.150 (Claude Code)',
        codex: 'codex-cli 0.130.0',
      }),
    });

    const ingest = await runCompat({
      command: 'ingest-release-notes',
      repoRoot: root,
      runId: RUN_ID,
      releaseNotesFiles: [notePath],
      now: new Date('2026-05-16T00:02:00.000Z'),
    });
    strictEqual(ingest.status, 'ingested');
    strictEqual(ingest.notes[0].kind, 'file');
    strictEqual(ingest.notes[0].status, 'stored');

    const check = await runCompat({
      command: 'check',
      repoRoot: root,
      runId: RUN_ID,
      baseline: baseline(),
    });
    strictEqual(check.status, 'gap_analysis_ready');
    strictEqual(check.release_notes_required, false);

    const plan = await runCompat({
      command: 'plan',
      repoRoot: root,
      runId: RUN_ID,
    });
    strictEqual(plan.status, 'planned');
    ok(plan.affected_surfaces.includes('hooks'));
    ok(plan.affected_surfaces.includes('model-effort'));
    ok(plan.affected_surfaces.includes('sandbox-permissions'));
    ok(plan.affected_surfaces.includes('subagents'));
    ok(plan.plan_pointer.endsWith('/update-plan.md'));
    const planText = await readFile(join(root, plan.plan_pointer), 'utf8');
    ok(planText.includes('Runtime Compatibility Update Plan'));
    ok(planText.includes('review-hooks'));
  });

  it('records release-note URLs as pointers only and blocks content-backed planning', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-compat-url-'));
    await runCompat({
      command: 'snapshot',
      repoRoot: root,
      runId: RUN_ID,
      baseline: baseline(),
      runner: fakeRunner({
        claude: '2.1.150 (Claude Code)',
        codex: 'codex-cli 0.130.0',
      }),
    });
    await runCompat({
      command: 'ingest-release-notes',
      repoRoot: root,
      runId: RUN_ID,
      releaseNotesUrls: ['https://example.test/notes'],
    });

    const plan = await runCompat({
      command: 'plan',
      repoRoot: root,
      runId: RUN_ID,
      baseline: baseline(),
    });
    strictEqual(plan.status, 'blocked_release_notes_required');
    ok(plan.next_steps[0].includes('ingest-release-notes'));
  });

  it('fetches release-note URLs only when explicitly requested and treats them as content-backed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-compat-url-fetch-'));
    const url = 'https://example.test/release-notes';
    await runCompat({
      command: 'snapshot',
      repoRoot: root,
      runId: RUN_ID,
      baseline: baseline(),
      runner: fakeRunner({
        claude: '2.1.150 (Claude Code)',
        codex: 'codex-cli 0.130.0',
      }),
    });

    const ingest = await runCompat({
      command: 'ingest-release-notes',
      repoRoot: root,
      runId: RUN_ID,
      releaseNotesUrls: [url],
      fetchReleaseNotesUrls: true,
      timeoutMs: 5000,
      now: new Date('2026-05-16T00:03:00.000Z'),
      urlFetcher: async (actualUrl, { timeoutMs }) => {
        strictEqual(actualUrl, url);
        strictEqual(timeoutMs, 5000);
        return {
          body: [
            '# Claude Code 2.1.150',
            '',
            'Plugin hooks changed Stop behavior.',
            'Model effort, sandbox, and permission handling changed.',
            '',
          ].join('\n'),
          finalUrl: actualUrl,
          contentType: 'text/markdown; charset=utf-8',
        };
      },
    });
    strictEqual(ingest.notes[0].kind, 'url');
    strictEqual(ingest.notes[0].status, 'stored');
    ok(ingest.notes[0].pointer.endsWith('.json'));
    ok(ingest.notes[0].content_pointer.endsWith('.md'));
    const rawText = await readFile(join(root, ingest.notes[0].content_pointer), 'utf8');
    ok(rawText.includes('Plugin hooks changed Stop behavior'));

    const check = await runCompat({
      command: 'check',
      repoRoot: root,
      runId: RUN_ID,
      baseline: baseline(),
    });
    strictEqual(check.status, 'gap_analysis_ready');
    strictEqual(check.release_notes_required, false);

    const plan = await runCompat({
      command: 'plan',
      repoRoot: root,
      runId: RUN_ID,
    });
    strictEqual(plan.status, 'planned');
    ok(plan.affected_surfaces.includes('hooks'));
    ok(plan.affected_surfaces.includes('model-effort'));
    ok(plan.affected_surfaces.includes('sandbox-permissions'));
  });

  it('parses arguments and rejects unsupported shapes', async () => {
    deepStrictEqual(parseArgs(['snapshot', '--timeout-ms', '60000']).command, 'snapshot');
    strictEqual(parseArgs(['check', '--latest']).latest, true);
    strictEqual(parseArgs(['ingest-release-notes', '--release-notes-url', 'https://example.test/notes', '--fetch-release-notes-url']).fetchReleaseNotesUrls, true);
    await rejects(
      () => runCompat({ command: 'ingest-release-notes', repoRoot: '/tmp', runId: RUN_ID }),
      /requires --release-notes-file or --release-notes-url/,
    );
    await rejects(
      () => runCompat({ command: 'ingest-release-notes', repoRoot: '/tmp', runId: RUN_ID, fetchReleaseNotesUrls: true }),
      /requires --release-notes-file or --release-notes-url/,
    );
  });

  it('extracts baseline versions from host parity docs', () => {
    const parsed = extractBaselineVersions('Observed with Claude Code `2.1.141`, Codex CLI\n`0.130.0`.');
    strictEqual(parsed.claude.version, '2.1.141');
    strictEqual(parsed.codex.version, '0.130.0');
  });
});

function baseline() {
  return {
    claude: { version: '2.1.141' },
    codex: { version: '0.130.0' },
  };
}

function fakeRunner(versions) {
  return async (command, args) => {
    if (args[0] === '--version') {
      return {
        ok: true,
        exit_code: 0,
        stdout: `${versions[command]}\n`,
        stderr: '',
        error_code: null,
        timed_out: false,
      };
    }
    return {
      ok: true,
      exit_code: 0,
      stdout: `${command} ${args.join(' ')} help text\n`,
      stderr: '',
      error_code: null,
      timed_out: false,
    };
  };
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}
