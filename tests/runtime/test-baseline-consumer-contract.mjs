// The baseline CONSUMER contract — ADR-0051 §Decision 4, hardened.
//
// The resolver's failure vocabulary is only half a contract. The other half is
// what five readers do with it, and every one of them had the same shape: an
// `if` ladder listing the two statuses it knew, and a benign meaning for
// everything else. Measured before this file existed:
//
//   doctor        an unlisted status fell to `stale` — a FRESHNESS verdict for
//                 an integrity failure, sending the operator to refresh a
//                 baseline they cannot read.
//   dashboard     fell to `available` with `baseline: null` — the one
//                 rendering that cannot be true.
//   compat        listed the two statuses a third time, so a new failure
//                 would have joined the drift comparison as though a version
//                 had been read.
//   state-readers turned compat's terminal `baseline_unusable` into
//                 `gap_analysis_ready` and carried `runtime:compat plan` as
//                 the next step — planning cannot repair a broken package.
//   cutover       filtered remediations through an enumerated CHECK_UNREADY
//                 set that never learned `unparseable`, so the audit correctly
//                 refused to call the cutover ready and then DROPPED the line
//                 saying what to fix.
//
// Each case below therefore drives a status the old ladders did not list —
// `escaped` for the live readers, `unparseable` for cutover — because a case
// that only exercises a listed status cannot see the fall-through.

import { describe, it } from 'node:test';
import { ok, strictEqual, notStrictEqual } from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { BASELINE_RELATIVE_PATH } from '../../plugins/runtime/scripts/lib/host-parity-baseline.mjs';
import { readHostParityBaseline } from '../../plugins/runtime/scripts/dashboard.mjs';
import { inspectCompatRuns } from '../../plugins/runtime/scripts/lib/state-readers.mjs';
import { runCutoverAudit } from '../../plugins/runtime/scripts/cutover-audit.mjs';

const HEADER = 'Observed on 2026-08-08 with Claude Code `2.1.226`, Codex CLI `0.147.0`.\n';
const NOW = new Date('2026-08-14T00:00:00Z');

// A package whose baseline resolves OUTSIDE it — the status none of the old
// ladders listed.
async function escapedPackage() {
  const outside = await mkdtemp(join(tmpdir(), 'bcc-outside-'));
  await writeFile(join(outside, 'evil.md'), HEADER);
  const root = await mkdtemp(join(tmpdir(), 'bcc-pkg-'));
  await mkdir(join(root, 'docs'), { recursive: true });
  await mkdir(join(root, '.claude-plugin'), { recursive: true });
  await writeFile(join(root, '.claude-plugin', 'plugin.json'), JSON.stringify({ version: '0.90.1' }));
  await symlink(join(outside, 'evil.md'), join(root, BASELINE_RELATIVE_PATH));
  return root;
}

async function compatRun(repoRoot, { gap, plan } = {}) {
  const runId = 'compat-20260814T000000Z-aaaaaa';
  const dir = join(repoRoot, '.agentic-plugins', 'runs', 'compat', runId);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'snapshot.json'), JSON.stringify({
    schema_version: 'runtime-compat-snapshot-1.0',
    run_id: runId,
    created_at: '2026-08-14T00:00:00Z',
    hosts: {},
  }));
  if (gap) await writeFile(join(dir, 'gap-analysis.json'), JSON.stringify({ schema_version: 'runtime-compat-gap-1.1', run_id: runId, ...gap }));
  if (plan) await writeFile(join(dir, 'plan.json'), JSON.stringify({ schema_version: 'runtime-compat-plan-1.1', run_id: runId, ...plan }));
  return runId;
}

describe('host-parity baseline consumer contract (ADR-0051 P2)', () => {
  it('dashboard reports an unlisted failure AS that failure, never as available', async () => {
    const resolved = await readHostParityBaseline({ repoRoot: '/tmp', pluginRoot: await escapedPackage() });

    strictEqual(resolved.status, 'escaped');
    strictEqual(resolved.baseline, null);
    notStrictEqual(resolved.status, 'available');
    ok(resolved.summary, 'the failure must be describable to an operator');
    strictEqual(resolved.provenance.status, 'escaped');
  });

  it('dashboard still reports a healthy baseline as available — CONTROL', async () => {
    // Without this, the case above passes with the function hard-wired to
    // return a failure for everything.
    const root = await mkdtemp(join(tmpdir(), 'bcc-pkg-'));
    await mkdir(join(root, 'docs'), { recursive: true });
    await mkdir(join(root, '.claude-plugin'), { recursive: true });
    await writeFile(join(root, '.claude-plugin', 'plugin.json'), JSON.stringify({ version: '0.90.1' }));
    await writeFile(join(root, BASELINE_RELATIVE_PATH), HEADER);

    const resolved = await readHostParityBaseline({ repoRoot: '/tmp', pluginRoot: root });
    strictEqual(resolved.status, 'available');
    strictEqual(resolved.baseline.claude, '2.1.226');
  });

  it('state-readers keeps an unusable baseline terminal instead of calling it analysis', async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), 'bcc-repo-'));
    await compatRun(repoRoot, {
      gap: {
        overall: { status: 'baseline_unusable', drift_class: 'baseline-escaped', release_notes_required: false },
        host_gaps: [{ host: 'claude', status: 'baseline_escaped' }, { host: 'codex', status: 'baseline_escaped' }],
      },
    });

    const runs = await inspectCompatRuns({ repoRoot });
    strictEqual(runs.latest.status, 'baseline_unusable');
    notStrictEqual(runs.latest.status, 'gap_analysis_ready');
    strictEqual(runs.status, 'blocked', 'and it must reach the collection level as a hard stop');
  });

  it('a plan artifact does not outrank an unusable baseline', async () => {
    // The plan branch was checked FIRST, so a run that had both reported
    // `plan_ready` — the most confident of all the wrong answers.
    const repoRoot = await mkdtemp(join(tmpdir(), 'bcc-repo-'));
    await compatRun(repoRoot, {
      gap: {
        overall: { status: 'baseline_unusable', drift_class: 'baseline-missing', release_notes_required: false },
        host_gaps: [],
      },
      plan: { status: 'ready', actionable: true },
    });

    const runs = await inspectCompatRuns({ repoRoot });
    strictEqual(runs.latest.status, 'baseline_unusable');
  });

  it('state-readers still reports a current run as available — CONTROL', async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), 'bcc-repo-'));
    await compatRun(repoRoot, {
      gap: { overall: { status: 'current', drift_class: 'none', release_notes_required: false }, host_gaps: [] },
    });

    const runs = await inspectCompatRuns({ repoRoot });
    strictEqual(runs.latest.status, 'current');
    strictEqual(runs.status, 'available');
  });

  it('state-readers sends an unrecognised per-run status to needs_attention, not available', async () => {
    // The collection mapping listed the three attention-worthy statuses and
    // called everything else available. Inverted: only `current` earns it.
    const repoRoot = await mkdtemp(join(tmpdir(), 'bcc-repo-'));
    await compatRun(repoRoot, {
      gap: { overall: { status: 'a-status-from-the-future', drift_class: 'none', release_notes_required: false }, host_gaps: [] },
    });

    const runs = await inspectCompatRuns({ repoRoot });
    strictEqual(runs.status, 'needs_attention');
  });

  it('cutover surfaces the remediation for a status its old set never learned', async () => {
    // `unparseable` is a status doctor emits TODAY. It was in neither
    // CHECK_PASS nor CHECK_UNREADY, so the audit refused readiness and then
    // dropped the only line telling the operator what to repair.
    const repoRoot = await mkdtemp(join(tmpdir(), 'bcc-repo-'));
    const doctorReport = {
      host_parity_baseline: {
        id: 'host_parity_baseline',
        label: 'Host parity baseline freshness',
        status: 'unparseable',
        evidence: { provenance: { path: '/pkg/docs/host-parity-baseline.md', status: 'unparseable' } },
        next_action: 'Repair /pkg/docs/host-parity-baseline.md — it carries no canonical header.',
      },
    };

    const report = await runCutoverAudit({ repoRoot, doctorReport, now: NOW });
    const surfaced = report.next_actions.find((entry) => entry.id === 'host_parity_baseline');
    ok(surfaced, 'an unready check must carry its next action into next_actions');
    strictEqual(surfaced.next_action, doctorReport.host_parity_baseline.next_action);
    strictEqual(report.ready_candidate, false);
  });

  it('cutover surfaces an ESCAPED baseline too — the status that does not exist yet in any set', async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), 'bcc-repo-'));
    const doctorReport = {
      host_parity_baseline: {
        id: 'host_parity_baseline',
        status: 'escaped',
        evidence: { provenance: { path: '/pkg/docs/host-parity-baseline.md', status: 'escaped' } },
        next_action: 'Reinstall the runtime plugin — the baseline resolves outside the package.',
      },
    };

    const report = await runCutoverAudit({ repoRoot, doctorReport, now: NOW });
    ok(report.next_actions.some((entry) => entry.id === 'host_parity_baseline'));
  });

  it('cutover does NOT invent a remediation for a passing check — CONTROL', async () => {
    // Complement-of-pass must not swallow the pass set. Without this the
    // filter could be `() => true` and both cases above would still be green.
    const repoRoot = await mkdtemp(join(tmpdir(), 'bcc-repo-'));
    const doctorReport = {
      host_parity_baseline: {
        id: 'host_parity_baseline',
        status: 'current',
        evidence: { provenance: { path: '/pkg/docs/host-parity-baseline.md', status: 'resolved' } },
        next_action: null,
      },
    };

    const report = await runCutoverAudit({ repoRoot, doctorReport, now: NOW });
    strictEqual(report.next_actions.some((entry) => entry.id === 'host_parity_baseline'), false);
  });
});
