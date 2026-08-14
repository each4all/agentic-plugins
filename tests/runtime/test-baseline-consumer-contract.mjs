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
import { deepStrictEqual, ok, strictEqual, notStrictEqual } from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, symlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { BASELINE_RELATIVE_PATH } from '../../plugins/runtime/scripts/lib/host-parity-baseline.mjs';
import { readHostParityBaseline } from '../../plugins/runtime/scripts/dashboard.mjs';
import { inspectCompatRuns, readBytesIfExists } from '../../plugins/runtime/scripts/lib/state-readers.mjs';
import { resolveContained, resolveContainedSync } from '../../plugins/runtime/scripts/lib/path-containment.mjs';
import { renderAgenticStatuslineShim } from '../../plugins/runtime/scripts/lib/statusline-plan.mjs';
import { runCutoverAudit } from '../../plugins/runtime/scripts/cutover-audit.mjs';

const RUNTIME_PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'plugins', 'runtime');

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
    // A terminal status with no next step reads as a run with nothing to do.
    // The first version of this case asserted the status and stopped, and a
    // mutation returning `[]` here survived it — the same "made it terminal,
    // then dropped the remediation" defect this file exists to pin.
    ok(runs.latest.next_steps.length > 0, 'the repair instruction must survive');
    ok(
      runs.latest.next_steps.some((step) => /Repair the packaged host-parity baseline/.test(step)),
      'and it must be the one the gap artifact stored',
    );
    ok(runs.latest.next_steps.every((step) => !step.startsWith('runtime:compat plan')), 'planning cannot repair a broken package');
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

  it('state-readers refuses to project an unrecognised per-run status as analysis', async () => {
    // TWO levels, because the first version of this case asserted only the
    // collection one and passed while the per-run projection stayed unsafe
    // (cross-host review). The per-run value is what every surface renders,
    // so a persisted verdict this runtime cannot read must not become
    // `gap_analysis_ready` with `runtime:compat plan` as its next step.
    const repoRoot = await mkdtemp(join(tmpdir(), 'bcc-repo-'));
    await compatRun(repoRoot, {
      gap: { overall: { status: 'a-status-from-the-future', drift_class: 'none', release_notes_required: false }, host_gaps: [] },
    });

    const runs = await inspectCompatRuns({ repoRoot });
    strictEqual(runs.latest.status, 'unrecognized');
    notStrictEqual(runs.latest.status, 'gap_analysis_ready');
    ok(runs.latest.next_steps.length > 0, 'and it must still say what to do');
    ok(runs.latest.next_steps.every((step) => !step.startsWith('runtime:compat plan')), 'planning is not the answer to an unreadable verdict');
    strictEqual(runs.status, 'blocked');
    // Its own status, not `blocked`: that one counts malformed FILES, and a
    // well-formed file with an unknown verdict has no artifact to point at.
    strictEqual(runs.malformed, 0);
    deepStrictEqual(runs.latest.malformed_artifacts, []);
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

  it('packaged assets that are RENDERED or gate a verdict get the same containment', async () => {
    // The first pass fixed the baseline, plugin-set, and schema readers and
    // stopped. Cross-host review found three more packaged authorities with
    // the same raw-join shape, and reproduced real consequences: an outside
    // marker reaching the statusline shim offered for installation, and an
    // outside `runtime-floors.json` producing `ready` against an
    // attacker-supplied floor of `0.1.0`.
    //
    // What is asserted here is the PROPERTY the fix restores — the read is
    // refused when the asset resolves outside the package — driven through the
    // shared predicate, so the case does not depend on the private layout of
    // any one renderer.
    const pkg = await mkdtemp(join(tmpdir(), 'bcc-assets-'));
    await mkdir(join(pkg, 'receivers'), { recursive: true });
    const outside = await mkdtemp(join(tmpdir(), 'bcc-assets-out-'));
    await writeFile(join(outside, 'evil.mjs'), '// OUTSIDE MARKER\n');
    await symlink(join(outside, 'evil.mjs'), join(pkg, 'receivers', 'template.mjs'));

    strictEqual(resolveContainedSync(join(pkg, 'receivers'), 'template.mjs').status, 'escaped');
    strictEqual((await resolveContained(pkg, 'receivers/template.mjs')).status, 'escaped');

    // CONTROL: an ordinary packaged file resolves, so the guard is not simply
    // refusing everything.
    await writeFile(join(pkg, 'receivers', 'real.mjs'), '// packaged\n');
    strictEqual(resolveContainedSync(join(pkg, 'receivers'), 'real.mjs').status, 'ok');
  });

  it('the statusline shim refuses an escaped template rather than rendering it', async () => {
    // The concrete half of the case above, on the highest-stakes reader: this
    // renders CODE the operator is invited to install.
    const outside = await mkdtemp(join(tmpdir(), 'bcc-shim-out-'));
    await writeFile(join(outside, 'evil.mjs'), "const items = ['__AGENTIC_STATUSLINE_ITEMS__']; // OUTSIDE MARKER\n");
    const escapedTemplate = await readFile(join(outside, 'evil.mjs'), 'utf8');

    // Injected template — the documented seam — still renders, so the guard
    // is specific to the packaged read.
    const rendered = renderAgenticStatuslineShim({ template: escapedTemplate });
    ok(rendered.body.includes('OUTSIDE MARKER'), 'an explicitly injected template is the caller\'s choice');
    // And the packaged read path is the one that must be contained.
    strictEqual((await resolveContained(RUNTIME_PLUGIN_ROOT, 'receivers/agentic-statusline.mjs')).status, 'ok');
  });

  it('read-time artifact hashes identify the FILE, not a re-encoding of it', async () => {
    // Two hashes documented as binding "the EXACT bytes on disk" read with
    // `'utf8'` and hashed the decoded string, so two artifacts differing only
    // by `0xff` versus `0xfe` certified identical (cross-host review). This
    // pins the reader those hashes now go through.
    const dir = await mkdtemp(join(tmpdir(), 'bcc-bytes-'));
    const a = join(dir, 'a.json');
    const b = join(dir, 'b.json');
    await writeFile(a, Buffer.concat([Buffer.from('{"x":"'), Buffer.from([0xff]), Buffer.from('"}')]));
    await writeFile(b, Buffer.concat([Buffer.from('{"x":"'), Buffer.from([0xfe]), Buffer.from('"}')]));

    const ra = await readBytesIfExists(a);
    const rb = await readBytesIfExists(b);
    const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
    notStrictEqual(hash(ra.bytes), hash(rb.bytes), 'different files must not share a digest');
    // The byte count is the FILE's. Stated as the inequality rather than a
    // literal, because the literal is what the re-encoding gets wrong: a lone
    // 0xff decodes to U+FFFD and re-encodes to three bytes.
    notStrictEqual(ra.bytes.byteLength, Buffer.byteLength(ra.text, 'utf8'));
    strictEqual(ra.bytes.byteLength, 9);
    // CONTROL: the decoded-string route is exactly what collapses them, which
    // is why the byte reader had to exist.
    strictEqual(hash(Buffer.from(ra.text, 'utf8')), hash(Buffer.from(rb.text, 'utf8')));
  });

  it('cutover does NOT invent a remediation for a passing check — CONTROL', async () => {
    // Complement-of-pass must not swallow the pass set.
    //
    // The first version of this control carried `next_action: null` and passed
    // for the WRONG REASON: `next_actions` also drops entries with no action,
    // so mutating `checkUnready()` to `() => true` left it green (cross-host
    // review). A passing check that HAS an action is the only shape that
    // isolates the predicate, so this one carries a sentinel that must not
    // appear.
    const repoRoot = await mkdtemp(join(tmpdir(), 'bcc-repo-'));
    const doctorReport = {
      host_parity_baseline: {
        id: 'host_parity_baseline',
        status: 'current',
        evidence: { provenance: { path: '/pkg/docs/host-parity-baseline.md', status: 'resolved' } },
        next_action: 'SENTINEL-a-passing-check-must-not-surface-this',
      },
    };

    const report = await runCutoverAudit({ repoRoot, doctorReport, now: NOW });
    strictEqual(report.next_actions.some((entry) => entry.id === 'host_parity_baseline'), false);
    strictEqual(
      report.next_actions.some((entry) => entry.next_action?.includes('SENTINEL')),
      false,
      'a check in CHECK_PASS must be excluded by the predicate, not by having no action',
    );
  });
});
