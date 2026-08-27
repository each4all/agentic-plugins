import { describe, it } from 'node:test';
import { deepStrictEqual, notStrictEqual, ok, strictEqual, rejects } from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  analyzeReleaseNote,
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
    strictEqual(snapshot.schema_version, 'runtime-compat-snapshot-1.2');
    strictEqual(snapshot.policy.adr, 'ADR-0026');
    strictEqual(report.policy.adr_pointer, 'docs/adr/0026-runtime-compatibility-drift-and-release-notes.md');
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
    ok(formatText(report).includes('policy: ADR-0026'));

    const gap = await readJson(join(root, report.gap_pointer));
    strictEqual(gap.schema_version, 'runtime-compat-gap-1.2');
    strictEqual(gap.policy.changed_version_rule.includes('changed host version'), true);
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
    strictEqual(ingest.policy.adr, 'ADR-0026');
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
    strictEqual(check.release_note_coverage.hosts.claude.required, true);
    strictEqual(check.release_note_coverage.hosts.claude.covered, true);
    deepStrictEqual(check.release_note_coverage.missing_required_hosts, []);

    const plan = await runCompat({
      command: 'plan',
      repoRoot: root,
      runId: RUN_ID,
    });
    strictEqual(plan.status, 'planned');
    strictEqual(plan.policy.mutation_boundary.includes('artifact-only'), true);
    ok(plan.affected_surfaces.includes('hooks'));
    ok(plan.affected_surfaces.includes('model-effort'));
    ok(plan.affected_surfaces.includes('sandbox-permissions'));
    ok(plan.affected_surfaces.includes('subagents'));
    ok(plan.plan_pointer.endsWith('/update-plan.md'));
    const planText = await readFile(join(root, plan.plan_pointer), 'utf8');
    ok(planText.includes('Runtime Compatibility Update Plan'));
    ok(planText.includes('review-hooks'));
  });

  it('requires content-backed release notes to cover the changed host and observed version', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-compat-note-coverage-'));
    const notePath = join(root, 'codex-release-notes.md');
    await writeFile(notePath, [
      'Codex CLI 0.130.0',
      'No Claude Code release note content is present here.',
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
    await runCompat({
      command: 'ingest-release-notes',
      repoRoot: root,
      runId: RUN_ID,
      releaseNotesFiles: [notePath],
    });

    const check = await runCompat({
      command: 'check',
      repoRoot: root,
      runId: RUN_ID,
      baseline: baseline(),
    });
    strictEqual(check.status, 'release_notes_required');
    strictEqual(check.release_notes_required, true);
    strictEqual(check.release_note_coverage.content_backed_count, 1);
    strictEqual(check.release_note_coverage.hosts.claude.required, true);
    strictEqual(check.release_note_coverage.hosts.claude.covered, false);
    deepStrictEqual(check.release_note_coverage.missing_required_hosts, ['claude']);
    ok(formatText(check).includes('missing-required-hosts=claude'));

    const plan = await runCompat({
      command: 'plan',
      repoRoot: root,
      runId: RUN_ID,
      baseline: baseline(),
    });
    strictEqual(plan.status, 'blocked_release_notes_required');
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
    const parsed = extractBaselineVersions('Observed on 2026-06-03 with Claude Code `2.1.141`, Codex CLI\n`0.130.0`.');
    strictEqual(parsed.claude.version, '2.1.141');
    strictEqual(parsed.codex.version, '0.130.0');
  });

  it('treats an unusable packaged baseline as terminal, not as a release-note gap', async () => {
    // ADR-0051 §Decision 4 + review F3: folding a missing/malformed baseline
    // into `no_baseline` produced `release_notes_required`, which told the
    // operator to go fetch release notes — an action that cannot repair a
    // broken package. Nothing was compared, so no drift verdict is honest.
    const root = await mkdtemp(join(tmpdir(), 'runtime-compat-baseline-unusable-'));
    await runCompat({
      command: 'snapshot',
      repoRoot: root,
      runId: RUN_ID,
      baseline: baseline(),
      runner: fakeRunner({ claude: '2.1.141 (Claude Code)', codex: 'codex-cli 0.130.0' }),
    });
    // `unreadable` and `escaped` are the P2 additions, and they are the point
    // of the loop rather than more of the same: this branch used to ENUMERATE
    // `missing` and `unparseable`, so a third failure status would have fallen
    // through to the drift comparison as though a version had been read. The
    // list is now derived from "not resolved".
    for (const status of ['missing', 'unparseable', 'unreadable', 'escaped']) {
      const out = await runCompat({
        command: 'check',
        repoRoot: root,
        runId: RUN_ID,
        baseline: {
          claude: { version: null },
          codex: { version: null },
          provenance: { source: 'package', path: '/nowhere/docs/host-parity-baseline.md', status },
        },
      });
      strictEqual(out.status, 'baseline_unusable', `${status} must be terminal`);
      strictEqual(out.release_notes_required, false, `${status} must not demand release notes`);
      ok(out.drift_class.startsWith('baseline-'), `${status} must not be described as host drift`);
      for (const gap of out.host_gaps) strictEqual(gap.status, `baseline_${status}`);
      // And the next step must be a REPAIR. `runtime:compat plan` was the old
      // answer here — an action that cannot fix a package that will not read.
      ok(
        out.next_steps.every((step) => !step.startsWith('runtime:compat plan')),
        `${status} must not route the operator to planning`,
      );
      ok(out.next_steps.some((step) => /Repair the packaged host-parity baseline/.test(step)), `${status} must name the repair`);
    }
  });

  it('plan is terminal on an unusable baseline too, not merely check', async () => {
    // `check` refused to call it drift and `plan` went on to emit
    // `status: planned`, `actionable: true`, and compatibility work steps for
    // a comparison that never happened (cross-host review, reproduced).
    // Terminal in one command and not the next is how the reader one layer up
    // ended up reporting `plan_ready` over a broken package.
    const root = await mkdtemp(join(tmpdir(), 'runtime-compat-plan-unusable-'));
    await runCompat({
      command: 'snapshot',
      repoRoot: root,
      runId: RUN_ID,
      baseline: baseline(),
      runner: fakeRunner({ claude: '2.1.141 (Claude Code)', codex: 'codex-cli 0.130.0' }),
    });
    const unusable = {
      claude: { version: null },
      codex: { version: null },
      provenance: { source: 'package', path: '/nowhere/docs/host-parity-baseline.md', status: 'escaped' },
    };
    const plan = await runCompat({ command: 'plan', repoRoot: root, runId: RUN_ID, baseline: unusable });
    strictEqual(plan.status, 'blocked_baseline_unusable');
    strictEqual(plan.actionable, false);
    ok(plan.next_steps.some((step) => /Repair the packaged host-parity baseline/.test(step)));

    // CONTROL: a resolvable baseline still plans.
    const ok_ = await runCompat({
      command: 'plan',
      repoRoot: root,
      runId: RUN_ID,
      baseline: {
        claude: { version: '2.1.141' },
        codex: { version: '0.130.0' },
        provenance: { source: 'package', path: '/pkg/docs/host-parity-baseline.md', status: 'resolved' },
      },
    });
    notStrictEqual(ok_.status, 'blocked_baseline_unusable');
  });

  it('stores the release-note bytes it hashed, not a second read of the source', async () => {
    // `copyFile` reopened the path after `readFile`, so a source replaced
    // between the two recorded one file's digest beside another file's bytes
    // (cross-host review reproduced 8 of 11 under a swap fixture). The bytes
    // were already in hand.
    const root = await mkdtemp(join(tmpdir(), 'runtime-compat-note-bytes-'));
    await runCompat({
      command: 'snapshot',
      repoRoot: root,
      runId: RUN_ID,
      baseline: baseline(),
      runner: fakeRunner({ claude: '2.1.141 (Claude Code)', codex: 'codex-cli 0.130.0' }),
    });
    const notes = join(root, 'notes.md');
    // Deliberately not valid UTF-8: a re-encoding would change these bytes.
    await writeFile(notes, Buffer.concat([Buffer.from('# Codex CLI 0.130.0\n\n'), Buffer.from([0xff, 0xfe]), Buffer.from('\n')]));
    const out = await runCompat({ command: 'ingest-release-notes', repoRoot: root, runId: RUN_ID, releaseNotesFiles: [notes] });
    // The persisted index is the authority for the recorded digest — the
    // command envelope is a summary of it.
    const index = JSON.parse(await readFile(join(root, out.release_notes_pointer), 'utf8'));
    const entry = index.notes.find((note) => note.kind === 'file');
    const storedPath = join(root, entry.pointer);
    const storedBytes = await readFile(storedPath);
    strictEqual(entry.sha256, createHash('sha256').update(storedBytes).digest('hex'), 'the recorded digest must identify the STORED bytes');
    strictEqual(entry.bytes, storedBytes.byteLength);
    deepStrictEqual(storedBytes, await readFile(notes), 'and the stored bytes must be the source bytes');
  });

  it('CONTROL: a legacy snapshot with no provenance is still read, not called unusable', async () => {
    // ADR-0051 §Decision 5 reads pre-provenance snapshots as legacy rather
    // than retro-filling them. Deriving "unusable" from `status !== 'resolved'`
    // would have swept those in — `null` is kept distinct on purpose, and this
    // is the case that proves the derivation did not over-reach.
    const root = await mkdtemp(join(tmpdir(), 'runtime-compat-baseline-legacy-'));
    await runCompat({
      command: 'snapshot',
      repoRoot: root,
      runId: RUN_ID,
      baseline: baseline(),
      runner: fakeRunner({ claude: '2.1.141 (Claude Code)', codex: 'codex-cli 0.130.0' }),
    });
    const out = await runCompat({
      command: 'check',
      repoRoot: root,
      runId: RUN_ID,
      baseline: { claude: { version: '2.1.141' }, codex: { version: '0.130.0' } },
    });
    notStrictEqual(out.status, 'baseline_unusable');
    strictEqual(out.drift_class, 'none');
  });

  it('does not report drift when the host runs exactly the baselined prerelease', async () => {
    // Measured: `extractSemver` stripped the prerelease off the OBSERVED
    // version while the resolver preserved it on the BASELINE version, and
    // this function compares the two — so an install running precisely the
    // baselined `0.147.0-rc.1` was reported as `version_changed`. One
    // normalizer, used symmetrically, is what removes the false positive.
    const root = await mkdtemp(join(tmpdir(), 'runtime-compat-prerelease-'));
    await runCompat({
      command: 'snapshot',
      repoRoot: root,
      runId: RUN_ID,
      baseline: baseline(),
      runner: fakeRunner({ claude: '2.1.226 (Claude Code)', codex: 'codex-cli 0.147.0-rc.1' }),
    });
    const out = await runCompat({
      command: 'check',
      repoRoot: root,
      runId: RUN_ID,
      baseline: {
        claude: { version: '2.1.226' },
        codex: { version: '0.147.0-rc.1' },
        provenance: { source: 'package', path: '/pkg/docs/host-parity-baseline.md', status: 'resolved' },
      },
    });
    strictEqual(out.drift_class, 'none');
    // CONTROL: a genuinely different prerelease is still drift.
    const drifted = await runCompat({
      command: 'check',
      repoRoot: root,
      runId: RUN_ID,
      baseline: {
        claude: { version: '2.1.226' },
        codex: { version: '0.147.0-rc.2' },
        provenance: { source: 'package', path: '/pkg/docs/host-parity-baseline.md', status: 'resolved' },
      },
    });
    strictEqual(drifted.drift_class, 'host-version-changed');
  });

  it('counts a release note that names the observed prerelease as covering it', async () => {
    // The MIRROR of the drift bug above, found by looking for the same defect
    // elsewhere rather than by another review round: the note scanner had its
    // own version pattern that dropped prerelease suffixes, while the observed
    // version kept them, and coverage compares the two. A note explicitly
    // naming `0.147.0-rc.1` did not cover an install running `0.147.0-rc.1`,
    // so `release_notes_required` stayed true with no way to satisfy it.
    const analysis = analyzeReleaseNote({
      note: { id: 'n1', kind: 'file', source: 'x' },
      text: 'Codex CLI 0.147.0-rc.1 release notes: hooks changed.',
    });
    ok(analysis.versions.includes('0.147.0-rc.1'), 'the scanner must speak the same grammar as the resolver');

    const root = await mkdtemp(join(tmpdir(), 'runtime-compat-note-prerelease-'));
    await runCompat({
      command: 'snapshot',
      repoRoot: root,
      runId: RUN_ID,
      baseline: baseline(),
      runner: fakeRunner({ claude: '2.1.226 (Claude Code)', codex: 'codex-cli 0.147.0-rc.1' }),
    });
    const notes = join(root, 'notes.md');
    await writeFile(notes, '# Codex CLI 0.147.0-rc.1\n\nhooks changed.\n');
    await runCompat({ command: 'ingest-release-notes', repoRoot: root, runId: RUN_ID, releaseNotesFiles: [notes] });
    const out = await runCompat({
      command: 'check',
      repoRoot: root,
      runId: RUN_ID,
      baseline: {
        claude: { version: '2.1.226' },
        codex: { version: '0.146.0' },
        provenance: { source: 'package', path: '/pkg/docs/host-parity-baseline.md', status: 'resolved' },
      },
    });
    strictEqual(out.drift_class, 'host-version-changed');
    strictEqual(out.release_notes_required, false, 'a note naming the observed prerelease covers it');

    // CONTROL: a note for a DIFFERENT release still does not cover it —
    // otherwise this passes with the comparison deleted entirely.
    const other = await mkdtemp(join(tmpdir(), 'runtime-compat-note-other-'));
    await runCompat({
      command: 'snapshot',
      repoRoot: other,
      runId: RUN_ID,
      baseline: baseline(),
      runner: fakeRunner({ claude: '2.1.226 (Claude Code)', codex: 'codex-cli 0.147.0-rc.1' }),
    });
    const otherNotes = join(other, 'notes.md');
    await writeFile(otherNotes, '# Codex CLI 0.148.0\n\nsomething else.\n');
    await runCompat({ command: 'ingest-release-notes', repoRoot: other, runId: RUN_ID, releaseNotesFiles: [otherNotes] });
    const uncovered = await runCompat({
      command: 'check',
      repoRoot: other,
      runId: RUN_ID,
      baseline: {
        claude: { version: '2.1.226' },
        codex: { version: '0.146.0' },
        provenance: { source: 'package', path: '/pkg/docs/host-parity-baseline.md', status: 'resolved' },
      },
    });
    strictEqual(uncovered.release_notes_required, true, 'a note for a different release must not count');
  });

  it('rejects a dateless version pair — a baseline that cannot be aged is not a baseline', () => {
    // ADR-0051 §Decision 4: one canonical grammar. compat used to accept this
    // form while doctor and dashboard required the dated header, so the same
    // file could parse for one reader and not another.
    const parsed = extractBaselineVersions('Observed with Claude Code `2.1.141`, Codex CLI\n`0.130.0`.');
    strictEqual(parsed.claude.version, null);
    strictEqual(parsed.codex.version, null);
  });

  it('emits the ADR-0047 standing notification watch on a no-drift plan run', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-compat-watch-standing-'));
    await runCompat({
      command: 'snapshot',
      repoRoot: root,
      runId: RUN_ID,
      baseline: baseline(),
      runner: fakeRunner({
        claude: '2.1.141 (Claude Code)',
        codex: 'codex-cli 0.130.0',
      }),
    });

    const plan = await runCompat({
      command: 'plan',
      repoRoot: root,
      runId: RUN_ID,
      baseline: baseline(),
    });
    strictEqual(plan.status, 'planned');
    strictEqual(plan.actionable, false, 'standing watch alone never makes a plan actionable');

    const watch = plan.notification_watch;
    strictEqual(watch.length, 2);
    const codexRow = watch.find((row) => row.id === 'codex-notify-payload-variants');
    const claudeRow = watch.find((row) => row.id === 'claude-notification-agent-types');
    ok(codexRow, 'codex notify= payload variant row is seeded');
    ok(claudeRow, 'claude agent notification-type row is seeded');
    strictEqual(codexRow.host, 'codex');
    strictEqual(claudeRow.host, 'claude');
    for (const row of watch) {
      strictEqual(row.standing, true);
      strictEqual(row.status, 'open');
      strictEqual(row.signal_detected, false);
      deepStrictEqual(row.signal_notes, []);
      strictEqual(row.policy.adr, 'ADR-0047');
      strictEqual(row.policy.adr_pointer, 'docs/adr/0047-notify-attention-gating-gc.md');
      ok(row.policy.rule.includes('never an automatic mapping'), row.policy.rule);
      ok(row.resolution_requires.includes('source-verified'), row.resolution_requires);
    }
    ok(codexRow.baseline_behavior.includes('silently no-ops'), codexRow.baseline_behavior);

    const planJson = await readJson(join(root, `.agentic-plugins/runs/compat/${RUN_ID}/plan.json`));
    strictEqual(planJson.schema_version, 'runtime-compat-plan-1.2');
    strictEqual(planJson.actionable, false);
    strictEqual(planJson.notification_watch.length, 2);
    const planText = await readFile(join(root, plan.plan_pointer), 'utf8');
    ok(planText.includes('Actionable: no'));
    ok(planText.includes('Notification Watch'));
    ok(planText.includes('codex-notify-payload-variants'));
    ok(planText.includes('claude-notification-agent-types'));
    ok(formatText(plan).includes('notification watch'));
    ok(
      !plan.recommended_sequence.some((item) => item.step.startsWith('review-notification-watch')),
      'no review step is injected without a detected signal',
    );
  });

  it('flags the Claude agent-notification watch row from ingested notes and requires a review step', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-compat-watch-claude-'));
    const notePath = join(root, 'claude-release-notes.md');
    await writeFile(notePath, [
      'Claude Code 2.1.198',
      'Adds agent_needs_input and agent_completed notification_type values to the Notification hook.',
      '',
    ].join('\n'));
    await runCompat({
      command: 'snapshot',
      repoRoot: root,
      runId: RUN_ID,
      baseline: baseline(),
      runner: fakeRunner({
        claude: '2.1.198 (Claude Code)',
        codex: 'codex-cli 0.130.0',
      }),
    });

    const blockedPlan = await runCompat({
      command: 'plan',
      repoRoot: root,
      runId: RUN_ID,
      baseline: baseline(),
    });
    strictEqual(blockedPlan.status, 'blocked_release_notes_required');
    strictEqual(blockedPlan.notification_watch.length, 2, 'watch rows stand even on a blocked plan');

    const ingest = await runCompat({
      command: 'ingest-release-notes',
      repoRoot: root,
      runId: RUN_ID,
      releaseNotesFiles: [notePath],
    });
    const plan = await runCompat({
      command: 'plan',
      repoRoot: root,
      runId: RUN_ID,
      baseline: baseline(),
    });
    strictEqual(plan.status, 'planned');
    strictEqual(plan.actionable, true, 'a detected watch signal makes the plan actionable');
    const claudeRow = plan.notification_watch.find((row) => row.id === 'claude-notification-agent-types');
    const codexRow = plan.notification_watch.find((row) => row.id === 'codex-notify-payload-variants');
    strictEqual(claudeRow.signal_detected, true);
    deepStrictEqual(claudeRow.signal_notes, [ingest.notes[0].id]);
    strictEqual(claudeRow.status, 'open', 'a signal annotates; it never resolves the row');
    strictEqual(codexRow.signal_detected, false);
    const reviewStep = plan.recommended_sequence.find(
      (item) => item.step === 'review-notification-watch-claude-notification-agent-types',
    );
    ok(reviewStep, 'signal adds a required review step');
    strictEqual(reviewStep.required, true);
    ok(reviewStep.reason.includes('source'), reviewStep.reason);
    const planText = await readFile(join(root, plan.plan_pointer), 'utf8');
    ok(planText.includes('signal detected'));
  });

  it('flags the Codex notify payload-variant watch row without ever mapping it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-compat-watch-codex-'));
    const notePath = join(root, 'codex-release-notes.md');
    await writeFile(notePath, [
      'Codex CLI 0.145.0',
      'notify now delivers approval-requested payloads to the configured program.',
      '',
    ].join('\n'));
    await runCompat({
      command: 'snapshot',
      repoRoot: root,
      runId: RUN_ID,
      baseline: baseline(),
      runner: fakeRunner({
        claude: '2.1.141 (Claude Code)',
        codex: 'codex-cli 0.145.0',
      }),
    });
    const ingest = await runCompat({
      command: 'ingest-release-notes',
      repoRoot: root,
      runId: RUN_ID,
      releaseNotesFiles: [notePath],
    });

    const plan = await runCompat({
      command: 'plan',
      repoRoot: root,
      runId: RUN_ID,
      baseline: baseline(),
    });
    strictEqual(plan.status, 'planned');
    const codexRow = plan.notification_watch.find((row) => row.id === 'codex-notify-payload-variants');
    const claudeRow = plan.notification_watch.find((row) => row.id === 'claude-notification-agent-types');
    strictEqual(codexRow.signal_detected, true);
    deepStrictEqual(codexRow.signal_notes, [ingest.notes[0].id]);
    strictEqual(claudeRow.signal_detected, false);
    ok(plan.recommended_sequence.some(
      (item) => item.step === 'review-notification-watch-codex-notify-payload-variants' && item.required,
    ));
    ok(
      codexRow.policy.rule.includes('never an automatic mapping'),
      'a watch hit is a planning row only — wiring needs a source-verified payload and its own decision',
    );
  });

  it('scopes notification-watch signals per token and per host (analyzeReleaseNote table)', () => {
    const CODEX_ROW = 'codex-notify-payload-variants';
    const CLAUDE_ROW = 'claude-notification-agent-types';
    const cases = [
      // Each Claude token must detect in isolation — a single fixture with
      // all three tokens would let one matcher silently die.
      ['Claude Code 2.1.198\nAdds agent_needs_input to the Notification hook.', [CLAUDE_ROW]],
      ['Claude Code 2.1.198\nAdds an agent_completed notification.', [CLAUDE_ROW]],
      ['Claude Code 2.1.198\nNew notification_type values are available.', [CLAUDE_ROW]],
      // Codex phrasings: notify=, forward order, reverse order, cross-line.
      ['Codex CLI 0.145.0\nnotify = ["notify-send"] is now honored.', [CODEX_ROW]],
      ['Codex CLI 0.145.0\nnotify now delivers approval-requested payloads.', [CODEX_ROW]],
      ['Codex CLI 0.145.0\nApproval requests now trigger notifications for operators.', [CODEX_ROW]],
      ['Codex CLI 0.145.0\nA new payload variant is emitted by\nnotify receivers.', [CODEX_ROW]],
      // Host scoping: host-named notes cannot signal the other host's row.
      ['Claude Code 2.1.198\nNew notification_type values are available.', [CLAUDE_ROW]],
      ['Codex CLI 0.145.0\nagent_needs_input is quoted here without its own host.', []],
      ['Claude Code 2.1.198\nnotify = changes quoted here belong to the other host.', []],
      // Known-variant negative: the recorded baseline variant is not a signal.
      ['Codex CLI 0.145.0\nnotify still emits agent-turn-complete only.', []],
      // Host-unknown note stays conservative: patterns may flag any row.
      ['The notify = program now receives approval payloads.', [CODEX_ROW]],
      // Both hosts named, both signal families present.
      ['Claude Code 2.1.198 and Codex CLI 0.145.0: notify = adds approval payloads; agent_needs_input added.', [CODEX_ROW, CLAUDE_ROW]],
    ];
    for (const [text, expected] of cases) {
      const analysis = analyzeReleaseNote({ note: { id: 'n', kind: 'file' }, text });
      deepStrictEqual(
        [...analysis.notification_watch].sort(),
        [...expected].sort(),
        `text: ${text.replace(/\n/g, ' / ')}`,
      );
    }
  });

  it('keeps distinct note ids and bodies across sequential ingests of same-named files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-compat-ingest-collision-'));
    await mkdir(join(root, 'a'), { recursive: true });
    await mkdir(join(root, 'b'), { recursive: true });
    await writeFile(join(root, 'a', 'CHANGELOG.md'), 'Claude Code 2.1.198\nagent_needs_input added.\n');
    await writeFile(join(root, 'b', 'CHANGELOG.md'), 'Codex CLI 0.145.0\nUnrelated fix notes.\n');
    await runCompat({
      command: 'snapshot',
      repoRoot: root,
      runId: RUN_ID,
      baseline: baseline(),
      runner: fakeRunner({
        claude: '2.1.198 (Claude Code)',
        codex: 'codex-cli 0.130.0',
      }),
    });

    const first = await runCompat({
      command: 'ingest-release-notes',
      repoRoot: root,
      runId: RUN_ID,
      releaseNotesFiles: [join(root, 'a', 'CHANGELOG.md')],
    });
    const second = await runCompat({
      command: 'ingest-release-notes',
      repoRoot: root,
      runId: RUN_ID,
      releaseNotesFiles: [join(root, 'b', 'CHANGELOG.md')],
    });
    ok(first.notes[0].id !== second.notes[0].id, 'sequential ingests must not reuse note ids');
    ok(first.notes[0].pointer !== second.notes[0].pointer, 'sequential ingests must not reuse artifact paths');
    const firstBody = await readFile(join(root, first.notes[0].pointer), 'utf8');
    const secondBody = await readFile(join(root, second.notes[0].pointer), 'utf8');
    ok(firstBody.includes('agent_needs_input'), 'first ingested body survives the second ingest');
    ok(secondBody.includes('Unrelated fix notes'), 'second ingested body is stored separately');
    const index = await readJson(join(root, `.agentic-plugins/runs/compat/${RUN_ID}/release-notes/index.json`));
    strictEqual(index.notes.length, 2);
    strictEqual(new Set(index.notes.map((note) => note.id)).size, 2);

    // The earlier Claude signal must survive the later unrelated ingest.
    const plan = await runCompat({
      command: 'plan',
      repoRoot: root,
      runId: RUN_ID,
      baseline: baseline(),
    });
    const claudeRow = plan.notification_watch.find((row) => row.id === 'claude-notification-agent-types');
    deepStrictEqual(claudeRow.signal_notes, [first.notes[0].id]);
  });
});

function baseline() {
  return {
    claude: { version: '2.1.141' },
    codex: { version: '0.130.0' },
  };
}

// ⚠ A `NEUTRAL_ASSURANCE` FIXTURE STOOD HERE and was injected into every
// `createSnapshot` call in this file (17 of them). It existed for HERMETICITY,
// not speed: `observeAssurance` probed the real machine, so these tests — which
// supply only a `runner` — read the developer's own home directory and
// `CODEX_HOME`, and the runner's generic help text parsed as an EMPTY plugin
// list that the floor correctly refused as "runtime not installed". Every drift
// assertion would then have been measuring a floor refusal.
//
// ADR-0056 §Decision 1 removed `observeAssurance` and with it the probe, so
// `createSnapshot` no longer touches the machine at all and the injection has
// nothing left to suppress. The hermeticity is now structural rather than
// fixture-supplied, which is why the seam is deleted rather than left inert:
// an option nothing reads is a fixture that looks load-bearing and is not.

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
