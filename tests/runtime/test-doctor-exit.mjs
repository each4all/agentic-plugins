// tests/runtime/test-doctor-exit.mjs
//
// The runtime:doctor diagnostic exit-code ladder (ADR-0024 operator track).
//
// Two layers, deliberately separate. The pure-function layer pins the partition
// and every ordering pair; the subprocess layer pins what a pure function cannot
// see — that a non-zero exit still leaves a PARSEABLE report on stdout. That
// invariant is the one an exit-code change breaks most easily, and `--record`
// proved the point before this change: an unwritable artifact directory took the
// whole diagnosis down with it (exit 1, zero bytes).
import { deepStrictEqual, ok, strictEqual } from 'node:assert';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, it } from 'node:test';

import { EXIT, EXIT_PROOF_SECTIONS, doctorExitCode, parseArgs } from '../../plugins/runtime/scripts/doctor.mjs';

const execFileAsync = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const DOCTOR = resolve(HERE, '../../plugins/runtime/scripts/doctor.mjs');

const notRequested = { requested: false, executed: false, mode: 'not_requested', status: 'not_requested' };

/** A minimal report shaped like the fields doctorExitCode actually reads. */
const report = (over = {}) => ({
  overall: { status: 'pass', hard_failures: [], warnings: [] },
  doctor_artifact: { written: false, requested: false, status: 'not_requested' },
  permission_proof: { ...notRequested },
  deep_peer_smoke: { ...notRequested },
  egress_ack_proof: { ...notRequested },
  workflow_continuation_proof: { ...notRequested },
  ...over,
});

/** A directional proof section under its executor, with the given lane statuses. */
const lanes = (mode, ...statuses) => ({
  requested: true,
  executed: true,
  mode,
  status: 'ignored-by-the-ladder',
  directions: Object.fromEntries(statuses.map((status, i) => [`lane_${i}`, { status }])),
});

const recorded = { written: true, requested: true, status: 'recorded' };
const recordFailed = { written: false, requested: true, status: 'write_failed', failed_phase: 'artifact', error: 'ENOTDIR' };
const warned = { status: 'warning', hard_failures: [], warnings: ['latest compatibility check needs follow-up'] };
const failed = { status: 'fail', hard_failures: ['claude cli unavailable'], warnings: [] };

/**
 * Run the real CLI with a PATH that cannot resolve `claude` or `codex`, and a
 * HOME with no plugin caches. The blockers are FORCED rather than inherited from
 * whatever the machine happens to have installed, so the same verdict is
 * produced on a developer laptop that has both CLIs and on a CI image that has
 * neither.
 */
async function runDoctorCli(args, { cwd, home }) {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [DOCTOR, ...args], {
      cwd,
      env: { PATH: '/usr/bin:/bin', HOME: home, TMPDIR: tmpdir() },
      maxBuffer: 64 * 1024 * 1024,
    });
    return { code: 0, stdout, stderr };
  } catch (err) {
    return { code: err.code, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

async function scratch(prefix) {
  const root = await mkdtemp(join(tmpdir(), `runtime-doctor-exit-${prefix}-`));
  const home = await mkdtemp(join(tmpdir(), `runtime-doctor-exit-home-${prefix}-`));
  return { root, home };
}

describe('runtime:doctor exit-code ladder', () => {
  it('exposes a closed, non-colliding code set and parses --strict', () => {
    deepStrictEqual([...new Set(Object.values(EXIT))].sort((a, b) => a - b), [0, 1, 2, 10, 20, 30, 40]);
    for (const code of Object.values(EXIT)) ok(Number.isInteger(code) && code >= 0 && code < 126, `${code} is a usable POSIX exit status`);
    strictEqual(parseArgs([]).strict, false);
    strictEqual(parseArgs(['--strict']).strict, true);
  });

  it('maps a clean report to OK and a hard-failure report to FINDINGS', () => {
    strictEqual(doctorExitCode(report()), EXIT.OK);
    strictEqual(doctorExitCode(report({ overall: failed })), EXIT.FINDINGS);
  });

  it('leaves warnings at OK by default and promotes them only under --strict', () => {
    // Measured, 2026-08-27: of the 78 doctor artifacts recorded in this
    // repository, 26 are `warning` with zero hard failures — the ordinary state
    // of a healthy machine. A default non-zero here would mark a third of all
    // runs failed and destroy the signal the ladder exists to add.
    strictEqual(doctorExitCode(report({ overall: warned })), EXIT.OK);
    strictEqual(doctorExitCode(report({ overall: warned }), { strict: true }), EXIT.FINDINGS);
    // Control: --strict does not invent findings on a genuinely clean report.
    strictEqual(doctorExitCode(report(), { strict: true }), EXIT.OK);
  });

  it('ignores a proof that was only PLANNED, and passes one whose every lane passed', () => {
    // The discriminator is `mode`, not `requested`: a plan-only preflight is
    // requested too, and reporting non-zero for it would make `--permission-proof`
    // alone a failure.
    strictEqual(doctorExitCode(report({
      permission_proof: { requested: true, executed: false, mode: 'plan_only_preflight', status: 'blocked' },
    })), EXIT.OK);
    strictEqual(doctorExitCode(report({
      permission_proof: lanes('explicit_permission_executor', 'passed', 'passed'),
    })), EXIT.OK);
  });

  it('reports PROOF_INCOMPLETE for a lane with no usable verdict, in every proof section', () => {
    const executorModes = {
      permission_proof: 'explicit_permission_executor',
      deep_peer_smoke: 'explicit_executor',
      workflow_continuation_proof: 'explicit_engineer_workflow_executor',
    };
    for (const [section, mode] of Object.entries(executorModes)) {
      for (const bad of ['blocked', 'skipped', 'failed', 'timed_out', 'unauthenticated']) {
        strictEqual(doctorExitCode(report({ [section]: lanes(mode, 'passed', bad) })), EXIT.PROOF_INCOMPLETE, `${section}/${bad}`);
      }
    }
    // Egress has no directions: the section IS the lane, and its executor can
    // also refuse BEFORE sending — `executed:false` under an explicit mode. That
    // pre-send refusal is only a warning in `overall` (correctly: no network
    // request happened), which is exactly how it escaped as exit 0 before.
    strictEqual(doctorExitCode(report({
      overall: warned,
      egress_ack_proof: { requested: true, executed: false, mode: 'explicit_egress_executor', status: 'blocked' },
    })), EXIT.PROOF_INCOMPLETE);
    strictEqual(doctorExitCode(report({
      egress_ack_proof: { requested: true, executed: true, mode: 'explicit_egress_executor', status: 'failed' },
    })), EXIT.PROOF_INCOMPLETE);
    strictEqual(doctorExitCode(report({
      egress_ack_proof: { requested: true, executed: true, mode: 'explicit_egress_executor', status: 'passed' },
    })), EXIT.OK);
  });

  it('reports PROOF_OPERATOR_ACTION only when every non-passing lane needs an operator', () => {
    strictEqual(doctorExitCode(report({
      permission_proof: lanes('explicit_permission_executor', 'passed', 'operator_action_required'),
    })), EXIT.PROOF_OPERATOR_ACTION);
    // A failed sibling lane OUTRANKS it. This is the case the section's own
    // aggregate status cannot express: every aggregator checks
    // operator_action_required BEFORE failed/blocked, so trusting the aggregate
    // would report the softer verdict and hide the failure.
    strictEqual(doctorExitCode(report({
      permission_proof: lanes('explicit_permission_executor', 'operator_action_required', 'failed'),
    })), EXIT.PROOF_INCOMPLETE);
  });

  it('reports RECORD_FAILED and gives it precedence over every finding', () => {
    strictEqual(doctorExitCode(report({ doctor_artifact: recordFailed })), EXIT.RECORD_FAILED);
    strictEqual(doctorExitCode(report({ doctor_artifact: recordFailed, overall: failed })), EXIT.RECORD_FAILED);
    strictEqual(doctorExitCode(report({
      doctor_artifact: recordFailed,
      permission_proof: lanes('explicit_permission_executor', 'blocked'),
    })), EXIT.RECORD_FAILED);
    // Control: a SUCCESSFUL record does not shadow the findings, and a run that
    // never asked to record cannot report a record failure.
    strictEqual(doctorExitCode(report({ doctor_artifact: recorded, overall: failed })), EXIT.FINDINGS);
    strictEqual(doctorExitCode(report({ doctor_artifact: recorded })), EXIT.OK);
  });

  it('orders the whole ladder root-cause first', () => {
    const both = { overall: failed, permission_proof: lanes('explicit_permission_executor', 'blocked') };
    strictEqual(doctorExitCode(report(both)), EXIT.FINDINGS, 'a hard failure explains the blocked proof under it');
    // Rules 3 and 4 sit ABOVE the strict promotion: a specific proof verdict is
    // more actionable than "some warning exists", and both are non-zero.
    strictEqual(doctorExitCode(report({
      overall: warned,
      permission_proof: lanes('explicit_permission_executor', 'passed', 'operator_action_required'),
    }), { strict: true }), EXIT.PROOF_OPERATOR_ACTION);
    strictEqual(doctorExitCode(report({
      overall: warned,
      permission_proof: lanes('explicit_permission_executor', 'blocked'),
    }), { strict: true }), EXIT.PROOF_INCOMPLETE);
  });
});

describe('runtime:doctor exit-code ladder (subprocess)', () => {
  it('keeps EXIT_PROOF_SECTIONS equal to the live report sections that carry an executor', async () => {
    // Drift guard measured against a REAL report rather than against a hand
    // list. A fifth proof section would appear here and fail the equality; a
    // section listed but no longer emitted would fail it the other way.
    const { root, home } = await scratch('sections');
    const res = await runDoctorCli([
      '--repo-root', root, '--format', 'json',
      '--permission-proof', '--deep-peer-smoke', '--workflow-continuation-proof', '--egress-ack-proof',
    ], { cwd: root, home });
    const parsed = JSON.parse(res.stdout);
    const withMode = Object.entries(parsed)
      .filter(([, value]) => value && typeof value === 'object' && typeof value.mode === 'string')
      .map(([key]) => key);
    ok(withMode.length > 0, 'the extractor found no mode-bearing section — the guard would be vacuous');
    // `sandbox_permission_probe` carries a mode and proves nothing: its whole
    // vocabulary is read_only_preflight / not_requested, asserted here so the
    // exclusion stays a measurement rather than an assumption.
    ok(['read_only_preflight', 'not_requested'].includes(parsed.sandbox_permission_probe.mode));
    deepStrictEqual(
      withMode.filter((key) => key !== 'sandbox_permission_probe').sort(),
      [...EXIT_PROOF_SECTIONS].sort(),
    );
    // And every one of them is plan-only here, so nothing above executed.
    for (const key of EXIT_PROOF_SECTIONS) strictEqual(parsed[key].mode, 'plan_only_preflight', key);
    strictEqual(parsed.exit_code, res.code);
  });

  it('exits FINDINGS on a hard-failure machine and still writes a parseable report to stdout', async () => {
    const { root, home } = await scratch('findings');
    const res = await runDoctorCli(['--repo-root', root, '--format', 'json'], { cwd: root, home });
    strictEqual(res.code, EXIT.FINDINGS, `stderr: ${res.stderr.slice(0, 400)}`);
    const parsed = JSON.parse(res.stdout);
    strictEqual(parsed.overall.status, 'fail');
    ok(parsed.overall.hard_failures.length > 0, 'the report explains the code it exited with');
    strictEqual(parsed.exit_code, res.code, 'the report and the process agree on one answer');
  });

  it('exits RECORD_FAILED with the report intact when --record cannot persist the artifact', async () => {
    const { root, home } = await scratch('record');
    // A regular FILE where the run directory must go: mkdir -p fails with
    // ENOTDIR for every user, root included, so this reproduces on any CI image.
    // A chmod-based fixture would silently succeed when the tests run as root.
    await mkdir(join(root, '.agentic-plugins', 'runs'), { recursive: true });
    await writeFile(join(root, '.agentic-plugins', 'runs', 'doctor'), 'not a directory\n');

    const res = await runDoctorCli(['--repo-root', root, '--format', 'json', '--record'], { cwd: root, home });
    strictEqual(res.code, EXIT.RECORD_FAILED, `stderr: ${res.stderr.slice(0, 400)}`);
    // Before this change the same setup exited 1 with ZERO bytes of stdout: the
    // diagnosis was lost because its filing cabinet was unwritable.
    ok(res.stdout.length > 0, 'the report survives a failed record');
    const parsed = JSON.parse(res.stdout);
    strictEqual(parsed.doctor_artifact.status, 'write_failed');
    strictEqual(parsed.doctor_artifact.written, false);
    strictEqual(parsed.doctor_artifact.requested, true);
    strictEqual(parsed.doctor_artifact.failed_phase, 'prepare');
    ok(typeof parsed.doctor_artifact.error === 'string' && parsed.doctor_artifact.error.length > 0);
    strictEqual(parsed.exit_code, EXIT.RECORD_FAILED);
    // RECORD_FAILED hides the findings underneath it by design, so the report
    // has to keep carrying them — this is the assertion behind that promise.
    strictEqual(parsed.overall.status, 'fail');
  });

  it('adds nothing to the recorded artifact', async () => {
    const { root, home } = await scratch('artifact');
    const runId = 'doctor-20260827T000000Z-abc123';
    const res = await runDoctorCli(['--repo-root', root, '--format', 'json', '--record', '--run-id', runId], { cwd: root, home });
    strictEqual(res.code, EXIT.FINDINGS, `stderr: ${res.stderr.slice(0, 400)}`);
    const live = JSON.parse(res.stdout);
    strictEqual(live.doctor_artifact.written, true);
    strictEqual(live.exit_code, EXIT.FINDINGS);

    const stored = JSON.parse(await readFile(join(root, '.agentic-plugins', 'runs', 'doctor', runId, 'doctor.json'), 'utf8'));
    // The claim is narrow on purpose. The snapshot is taken before `exit_code`
    // is assigned, so the ladder adds NOTHING to the stored report; that is not
    // the same as whole-artifact byte-identity across runs, which this ordering
    // cannot buy — the report inventories previous runs, so two sequential runs
    // legitimately differ.
    ok(!('exit_code' in stored.report), 'the recorded report must not carry exit_code');
    // The stronger form, and the one that would actually catch a regression: the
    // stored report's top-level shape differs from the live one by exactly this
    // one key. A raw-bytes scan cannot express that — `exit_code` is also a
    // long-standing NESTED key on every host-CLI probe result, so searching the
    // bytes matches ten pre-existing occurrences and asserts nothing.
    const added = Object.keys(live).filter((key) => !(key in stored.report));
    const dropped = Object.keys(stored.report).filter((key) => !(key in live));
    deepStrictEqual(added, ['exit_code']);
    deepStrictEqual(dropped, []);
  });

  it('keeps usage errors at INVALID and --help at OK', async () => {
    const { root, home } = await scratch('usage');
    const bad = await runDoctorCli(['--format', 'xml'], { cwd: root, home });
    strictEqual(bad.code, EXIT.INVALID);
    strictEqual(bad.stdout, '', 'a usage error produces no report');
    const help = await runDoctorCli(['--help'], { cwd: root, home });
    strictEqual(help.code, EXIT.OK);
    ok(help.stdout.includes('Exit codes:'), 'usage documents the ladder');
  });

  it('surfaces the code and a failed record in text output too', async () => {
    const { root, home } = await scratch('text');
    const plain = await runDoctorCli(['--repo-root', root], { cwd: root, home });
    strictEqual(plain.code, EXIT.FINDINGS);
    ok(/^exit-code: 10 \(findings\)$/m.test(plain.stdout), `text output should name the code:\n${plain.stdout.slice(0, 400)}`);

    await mkdir(join(root, '.agentic-plugins', 'runs'), { recursive: true });
    await writeFile(join(root, '.agentic-plugins', 'runs', 'doctor'), 'not a directory\n');
    const failedRecord = await runDoctorCli(['--repo-root', root, '--record'], { cwd: root, home });
    strictEqual(failedRecord.code, EXIT.RECORD_FAILED);
    // The artifact line below it is gated on `written`, so without an explicit
    // write_failed line the default format would print the code and then say
    // nothing about why.
    ok(/^exit-code: 40 \(record-failed\)$/m.test(failedRecord.stdout));
    ok(/^doctor-artifact: write_failed at prepare phase \(/m.test(failedRecord.stdout), `text output should explain the failed record:\n${failedRecord.stdout.slice(0, 600)}`);
  });
});
