// tests/runtime/test-doctor-schema-dual-read.mjs
//
// ADR-0056 §Decision 5 + §Consequences — the doctor schema bump, and the dual
// reader that has to ship in the SAME release as the producer.
//
// ⚠ WHY THIS IS THE ONE SEQUENCING RULE THAT CANNOT BE DEFERRED. `doctor` scans
// EVERY retained `doctor.json`, and a rejected artifact increments `malformed`.
// `status: malformed > 0 ? 'blocked' : …` means a fresh proof never clears it,
// so a producer that lands without a reader for the OLD version turns the whole
// retained corpus into a fault with no operator path back. Measured on the real
// corpus when this was last considered: bumping the inner report alone moved
// `doctor_runs` from `available malformed=0` to `blocked malformed=70`.
//
// The mirror matters as much as the original: `dashboard.mjs` pins BOTH doctor
// versions independently of `doctor.mjs`, so a fix applied to one and not the
// other leaves the same fault on the surface an operator actually reads.

import { describe, it } from 'node:test';
import { ok, strictEqual } from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { inspectLatestDoctorRun } from '../../plugins/runtime/scripts/dashboard.mjs';

const ERAS = [
  // The version every retained artifact on disk carries today.
  { label: 'assurance-era producer', artifact: 'runtime-doctor-artifact-1.0', report: 'runtime-doctor-1.0' },
  // The version this runtime writes.
  { label: 'post-assurance producer', artifact: 'runtime-doctor-artifact-1.1', report: 'runtime-doctor-1.1' },
];

async function seed(runs) {
  const repoRoot = await mkdtemp(join(tmpdir(), 'doctor-dual-'));
  for (const [index, run] of runs.entries()) {
    const runId = `doctor-2026082${index}T000000Z-aaaaa${index}`;
    const dir = join(repoRoot, '.agentic-plugins', 'runs', 'doctor', runId);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'doctor.json'), JSON.stringify({
      schema_version: run.artifact,
      run_id: runId,
      runtime_version: '0.95.0',
      status: 'recorded',
      generated_at: `2026-08-2${index}T00:00:00.000Z`,
      report: { schema_version: run.report },
    }));
  }
  return repoRoot;
}

// ⚠ THE DOCTOR-SIDE HALF IS DRIVEN THROUGH `runDoctor` IN `test-doctor.mjs`,
// not here. `inspectDoctorRuns` is private to `doctor.mjs`, and exporting it to
// make a test convenient would widen the module's public surface for the test's
// benefit — the opposite of what the seam rules in this repository ask for. The
// dashboard's reader IS exported (it is a public projection), so the mirror is
// asserted directly below.

describe('the dashboard pins the same two versions, independently', () => {
  for (const era of ERAS) {
    it(`the newest ${era.label} artifact is available on the dashboard too`, async () => {
      const repoRoot = await seed([era]);
      const latest = await inspectLatestDoctorRun({ repoRoot });
      strictEqual(latest.status, 'available', `${era.report} must not block the Tier 2 doctor row`);
    });
  }

  it('a MIXED tuple is refused — outer and inner bump together, so no producer emits one', async () => {
    // ⚠ MEASURED AS UNCOVERED. Replacing the matched-pair predicate with two
    // independent `includes()` checks turned NO test red, because nothing drove
    // a mixed tuple. `(artifact-1.1, report-1.0)` and `(artifact-1.0,
    // report-1.1)` are shapes no producer can write, so an artifact carrying one
    // is corrupt or hand-edited — and refusing those is this predicate's job.
    for (const [artifact, report] of [
      ['runtime-doctor-artifact-1.0', 'runtime-doctor-1.1'],
      ['runtime-doctor-artifact-1.1', 'runtime-doctor-1.0'],
    ]) {
      const repoRoot = await seed([{ artifact, report }]);
      const latest = await inspectLatestDoctorRun({ repoRoot });
      strictEqual(latest.status, 'blocked', `${artifact} + ${report} must be refused`);
    }
  });

  it('CONTROL: an unknown version blocks the dashboard row', async () => {
    const repoRoot = await seed([{ artifact: 'runtime-doctor-artifact-9.9', report: 'runtime-doctor-9.9' }]);
    const latest = await inspectLatestDoctorRun({ repoRoot });
    strictEqual(latest.status, 'blocked');
  });

  it('a POST-REMOVAL report reports `not-applicable`, never `legacy-unassured`', async () => {
    // ⚠ ABSENCE MEANS TWO DIFFERENT THINGS, and this case is the only thing
    // that distinguishes them. In a `runtime-doctor-1.0` report a missing
    // assurance section means the report PREDATES the section; in `1.1` and
    // later, absence is NORMAL because no producer writes one. Saying "it
    // predates the section" about a report written after the removal is simply
    // false, and the decoder gates on the report version to avoid it.
    //
    // Mutation-verified: deleting the report-version gate in
    // `legacy-assurance-reader.mjs` turns this red. It was added after a
    // measurement showed the surrounding cases did NOT — they asserted the
    // artifact's readability and never looked at the projected status.
    const repoRoot = await seed([{ artifact: 'runtime-doctor-artifact-1.1', report: 'runtime-doctor-1.1' }]);
    const latest = await inspectLatestDoctorRun({ repoRoot });
    strictEqual(latest.latest.historical_assurance.status, 'not-applicable');
    strictEqual(latest.latest.historical_assurance.schema_era, 'post-assurance');
    ok(/after the compatibility-assurance layer was removed/.test(latest.latest.historical_assurance.reason));
  });

  it('CONTROL: a 1.0 report with NO section still reports `legacy-unassured`', async () => {
    // The other half of the pair. Without it, the case above would pass against
    // a decoder that returned `not-applicable` for everything — which would lose
    // the one true statement the decoder exists to make about the old corpus.
    const repoRoot = await seed([{ artifact: 'runtime-doctor-artifact-1.0', report: 'runtime-doctor-1.0' }]);
    const latest = await inspectLatestDoctorRun({ repoRoot });
    strictEqual(latest.latest.historical_assurance.status, 'legacy-unassured');
    strictEqual(latest.latest.historical_assurance.schema_era, 'assurance-era');
  });

  it('a historical assurance section is reported as HISTORICAL, never as a current verdict', async () => {
    // ADR-0056 §Decision 5 keeps `projectRecordedAssurance` as a legacy-only
    // decoder precisely so this stays sayable. The era is part of the value, not
    // context around it, because §Decision 6 rule 1 keys on it.
    const repoRoot = await mkdtemp(join(tmpdir(), 'doctor-hist-'));
    const runId = 'doctor-20260820T000000Z-aaaaaa';
    const dir = join(repoRoot, '.agentic-plugins', 'runs', 'doctor', runId);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'doctor.json'), JSON.stringify({
      schema_version: 'runtime-doctor-artifact-1.0',
      run_id: runId,
      runtime_version: '0.94.0',
      status: 'recorded',
      generated_at: '2026-08-20T00:00:00.000Z',
      report: {
        schema_version: 'runtime-doctor-1.0',
        host_parity_assurance: {
          schema_version: 'runtime-host-assurance-result-1.0',
          status: 'covered',
          evidence: { grant_id: 'claude-2-1-234-235-codex-0-147-0' },
        },
      },
    }));
    const latest = await inspectLatestDoctorRun({ repoRoot });
    strictEqual(latest.status, 'available');
    strictEqual(latest.latest.historical_assurance.status, 'covered');
    strictEqual(latest.latest.historical_assurance.schema_era, 'assurance-era');
    strictEqual(latest.latest.historical_assurance.grant_id, 'claude-2-1-234-235-codex-0-147-0');
    // ⚠ THE FIELD IS NOT CALLED `assurance`. A consumer reaching for that name
    // gets `undefined`, which is the point: the rename is what stops a historical
    // verdict being read in the present tense.
    strictEqual(latest.latest.assurance, undefined);
  });
});
