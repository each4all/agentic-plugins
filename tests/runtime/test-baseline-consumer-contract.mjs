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
import { cp, mkdtemp, mkdir, readFile, writeFile, symlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ASSURANCE_SCHEMA_FAMILY, BASELINE_RELATIVE_PATH } from '../../plugins/runtime/scripts/lib/host-parity-baseline.mjs';
import { buildDashboardReport, readHostAssurance, readHostParityBaseline, renderDashboardText } from '../../plugins/runtime/scripts/dashboard.mjs';
import { inspectCompatRuns, readBytesIfExists } from '../../plugins/runtime/scripts/lib/state-readers.mjs';
import { resolveContained, resolveContainedSync } from '../../plugins/runtime/scripts/lib/path-containment.mjs';
import { renderAgenticStatuslineShim } from '../../plugins/runtime/scripts/lib/statusline-plan.mjs';
import { runCutoverAudit } from '../../plugins/runtime/scripts/cutover-audit.mjs';
import { formatText, runDoctor } from '../../plugins/runtime/scripts/doctor.mjs';
import { evaluateAssurance, projectRecordedAssurance } from '../../plugins/runtime/scripts/lib/assurance-result.mjs';
import { canonicalJson, loadSchema } from '../../plugins/runtime/scripts/lib/schema-validate.mjs';
import { loadPluginSet } from '../../plugins/runtime/scripts/lib/plugin-set.mjs';

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
  // ADR-0053 §Decision 4 — a `1.1` artifact CARRIES an assurance result; the
  // reader refuses one that declares the schema and omits the section, because a
  // truncated write is not history. The default is `covered` so these fixtures
  // keep meaning "a healthy compat run"; a case that wants otherwise overrides
  // `overall.assurance` explicitly.
  if (gap) {
    const overall = gap.overall === undefined
      ? undefined
      : { assurance: { schema_version: 'runtime-host-assurance-result-1.0', status: 'covered', evidence: { grant_id: 'fixture-grant' } }, ...gap.overall };
    await writeFile(join(dir, 'gap-analysis.json'), JSON.stringify({
      schema_version: 'runtime-compat-gap-1.1', run_id: runId, ...gap, ...(overall === undefined ? {} : { overall }),
    }));
  }
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

// ---------------------------------------------------------------------------
// The assurance axis (ADR-0053 §Decision 3, ADR-0054 §Decision 4)
// ---------------------------------------------------------------------------
//
// The same principle as the rest of this file, applied to a new fact: a case
// that exercises only a listed status cannot see the fall-through. For
// assurance the fall-through direction is worse than for freshness — a reader
// that turned an unknown state into a positive would report that a human
// accepted a host nobody reviewed, which is the one failure this whole plane
// exists to prevent. So the CONTROL below is not decoration: without a case
// that must reach `covered`, every negative here passes against an
// implementation hard-wired to return `unassured`.

const ASSURANCE_SCHEMA = await loadSchema(ASSURANCE_SCHEMA_FAMILY, { pluginRoot: RUNTIME_PLUGIN_ROOT });
const PLUGIN_SET = await loadPluginSet({ pluginRoot: RUNTIME_PLUGIN_ROOT });
const OBSERVED = { claude: '2.1.233', codex: '0.147.0' };
const ASSURED_HEADER = `Observed on 2026-08-16 with Claude Code \`${OBSERVED.claude}\`, Codex CLI \`${OBSERVED.codex}\`.\n`;
// A clock AFTER the fixture grant's `reviewed_at`, and its own constant rather
// than the file's `NOW`. The rule that forces this is real and worth naming:
// `assuranceRecordIssues` rejects a `reviewed_at` in the future, so running the
// doctor at the file's 2026-08-14 turns a perfectly good grant into an
// incoherent record and every case below reports `unassured` — including the
// CONTROL, which is the only reason it was caught rather than shipped as eight
// negatives passing for the wrong reason.
const ASSURANCE_NOW = new Date('2026-08-17T00:00:00Z');

/** The one grant shape the controls use; `patch` is a departure from it. */
function grant(patch = {}) {
  return {
    id: 'host-pair-2026-08-16',
    state: 'granted',
    reviewed_at: '2026-08-16',
    review_provenance: { kind: 'adr', reference: 'ADR-0054' },
    cohort: [{ claude: OBSERVED.claude, codex: OBSERVED.codex }],
    packages: { runtime: '0.90.3' },
    residuals: [],
    ...patch,
  };
}

const assuranceRecord = (grants = [grant()]) => ({ schema: 'runtime-host-assurance-1.0', grants });

/**
 * A fixture PACKAGE carrying a baseline, an assurance block, and the real
 * `data/` directory.
 *
 * The real `data/` rather than a fixture one, deliberately: the schema decides
 * whether a record validates and the plugin set decides which hosts a package
 * binding must hold on, so a fixture copy of either would let this suite pass
 * against rules the shipped package does not have. It also matters for the
 * negative cases — the existing doctor fixtures carry only the baseline file,
 * and against one of those an "old baseline" case would be exercising package
 * corruption rather than legacy absence (cross-host review).
 */
async function assurancePackage({ header = ASSURED_HEADER, record = assuranceRecord(), withData = true, tail = '' } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'bcc-assurance-pkg-'));
  await mkdir(join(root, 'docs'), { recursive: true });
  await mkdir(join(root, '.claude-plugin'), { recursive: true });
  await writeFile(join(root, '.claude-plugin', 'plugin.json'), JSON.stringify({ version: '0.90.3' }));
  if (withData) await cp(join(RUNTIME_PLUGIN_ROOT, 'data'), join(root, 'data'), { recursive: true });
  // The block must be BYTE-IDENTICAL to the canonical serialization of what it
  // parses to, or the reader reports `noncanonical`. Using the shipped
  // serializer rather than `JSON.stringify` is what makes these fixtures
  // exercise the real grammar instead of a lookalike.
  const block = record === null
    ? ''
    : `\n<!-- BEGIN COMPATIBILITY ASSURANCE -->\n\`\`\`json\n${canonicalJson(record, ASSURANCE_SCHEMA)}\`\`\`\n<!-- END COMPATIBILITY ASSURANCE -->\n`;
  await writeFile(join(root, BASELINE_RELATIVE_PATH), `${header}${block}${tail}`);
  return root;
}

const okResult = (stdout = '') => ({ ok: true, exit_code: 0, stdout, stderr: '', error_code: null, timed_out: false });
const fakeRunner = (map) => async (command, args) => map[`${command} ${args.join(' ')}`]
  ?? ({ ok: false, exit_code: null, stdout: '', stderr: '', error_code: 'ENOENT', error_message: `spawn ${command} ENOENT`, timed_out: false });

/** Host probes that observe OBSERVED and report `runtime 0.90.3` enabled on both hosts. */
function probes({ claudeList = null, codexList = null, claudeListOk = true, claudeVersion = null } = {}) {
  // MEASURED, not guessed: `parseClaudePluginList`'s leading `\S?` consumes one
  // non-space character — the `>` marker real output carries — so a fixture
  // without it parses the plugin name as `untime`, the CONTROL fails, and every
  // departure then passes for the wrong reason. This is the house fixture shape
  // (tests/runtime/test-machine-probe.mjs).
  const claudeText = claudeList ?? 'Installed plugins:\n\n  > runtime@agentic-plugins\n    Version: 0.90.3\n    Scope: user\n    Status: enabled\n'
    // `attention` is installed in every fixture even though most grants bind
    // only `runtime`: the matcher infers nothing about packages a grant does
    // not name, so the extra row is inert for those cases and lets the residual
    // case bind a REAL consumed surface. ADR-0053's own worked example is the
    // Notification hook payload, which `plugins/attention` consumes.
    + '  > attention@agentic-plugins\n    Version: 0.9.0\n    Scope: user\n    Status: enabled\n';
  const codexJson = codexList ?? JSON.stringify({
    installed: [
      { name: 'runtime', marketplaceName: 'agentic-plugins', version: '0.90.3', installed: true, enabled: true },
      { name: 'attention', marketplaceName: 'agentic-plugins', version: '0.9.0', installed: true, enabled: true },
    ],
  });
  return {
    'claude --version': okResult(`${claudeVersion ?? OBSERVED.claude} (Claude Code)\n`),
    'claude plugin list': claudeListOk
      ? okResult(claudeText)
      // A FAILED command that still printed usable-looking text. This is the
      // measured false-coverage shape: `parseClaudePluginList` is handed stdout
      // whether or not the command succeeded, so its entries are
      // indistinguishable from a clean probe's and only the status tells them
      // apart.
      : { ok: false, exit_code: 1, stdout: claudeText, stderr: 'boom', error_code: null, timed_out: false },
    'codex --version': okResult(`codex-cli ${OBSERVED.codex}\n`),
    'codex plugin list --json': okResult(codexJson),
  };
}

async function assuranceRun({ pkg, probeMap } = {}) {
  const repoRoot = await mkdtemp(join(tmpdir(), 'bcc-assurance-repo-'));
  const homeDir = await mkdtemp(join(tmpdir(), 'bcc-assurance-home-'));
  return runDoctor({ repoRoot, homeDir, pluginRoot: pkg, runner: fakeRunner(probeMap ?? probes()), now: ASSURANCE_NOW, env: { PATH: '/usr/bin:/bin' } });
}

describe('host-parity assurance consumer contract (ADR-0053 §Decision 3, ADR-0054 §Decision 4)', () => {
  it('CONTROL: a grant naming this host pair and this installed runtime is COVERED', async () => {
    // Every case below is a departure from this one.
    const report = await assuranceRun({ pkg: await assurancePackage() });
    strictEqual(report.host_parity_assurance.status, 'covered');
    strictEqual(report.host_parity_assurance.evidence.grant_id, 'host-pair-2026-08-16');
    strictEqual(report.host_parity_assurance.next_action, null);
    strictEqual(report.host_parity_assurance.schema_version, 'runtime-host-assurance-result-1.0');
    // ADR-0054 §Decision 4 — the REPORT does not bump. Asserted as the property
    // rather than cited: the measured alternative moves the retained doctor
    // collection to `blocked malformed=N`, which no fresh proof clears.
    strictEqual(report.schema_version, 'runtime-doctor-1.0');
  });

  it('a new reader against an OLD baseline is unassured, and says to UPGRADE rather than to repair', async () => {
    // ADR-0053 §Decision 11's degrade rule. The two remedies are opposite, so
    // the classification has to be too — sending an operator to edit a file
    // that is fine is a wrong instruction, not a cautious one.
    const report = await assuranceRun({ pkg: await assurancePackage({ record: null }) });
    strictEqual(report.host_parity_assurance.status, 'unassured');
    notStrictEqual(report.host_parity_assurance.status, 'covered');
    strictEqual(report.host_parity_assurance.evidence.record_status, 'absent');
    ok(/Update the runtime plugin/.test(report.host_parity_assurance.next_action));
    // Exactness is UNAFFECTED, which is the whole point of the split: this
    // baseline is current AND uncovered, and a reader that folded the two would
    // have to call it one or the other.
    strictEqual(report.host_parity_baseline.status, 'current');
  });

  it('an integrity failure beside a PARSEABLE assurance section is blocked, never covered', async () => {
    // §Decision 3's first named case. The escaped target carries a perfectly
    // good record — measured: the pure grammar reads that same text as
    // `resolved` — so a reader that consulted the record before the file it
    // lives in would report coverage from a document the package does not own.
    const outside = await mkdtemp(join(tmpdir(), 'bcc-assurance-out-'));
    const donor = await assurancePackage();
    await cp(join(donor, BASELINE_RELATIVE_PATH), join(outside, 'evil.md'));
    const pkg = await mkdtemp(join(tmpdir(), 'bcc-assurance-escaped-'));
    await mkdir(join(pkg, 'docs'), { recursive: true });
    await mkdir(join(pkg, '.claude-plugin'), { recursive: true });
    await writeFile(join(pkg, '.claude-plugin', 'plugin.json'), JSON.stringify({ version: '0.90.3' }));
    await cp(join(RUNTIME_PLUGIN_ROOT, 'data'), join(pkg, 'data'), { recursive: true });
    await symlink(join(outside, 'evil.md'), join(pkg, BASELINE_RELATIVE_PATH));

    const report = await assuranceRun({ pkg });
    strictEqual(report.host_parity_assurance.status, 'blocked');
    notStrictEqual(report.host_parity_assurance.status, 'covered');
    strictEqual(report.host_parity_assurance.evidence.record_status, 'baseline-unavailable');
    // The action is the INTEGRITY action, not a record repair.
    ok(/Reinstall the runtime plugin/.test(report.host_parity_assurance.next_action));
  });

  it('a valid grant whose cohort does not name this host pair is unassured', async () => {
    // §Decision 7 — a cohort is an explicit finite set of reviewed tuples, and
    // being one patch release away from a reviewed pair is not membership.
    const report = await assuranceRun({
      pkg: await assurancePackage({ record: assuranceRecord([grant({ cohort: [{ claude: '2.1.232', codex: '0.147.0' }] })]) }),
    });
    strictEqual(report.host_parity_assurance.status, 'unassured');
    ok(report.host_parity_assurance.evidence.reasons.some((reason) => /no grant names the host pair/.test(reason)));
  });

  it('an AMBIGUOUS install state is unassured even with a matching grant', async () => {
    // §Decision 5 — an ambiguous match is unassured. Claude installs are
    // SCOPED, so one plugin legitimately appears twice at different versions;
    // the primary entry stays last-wins for every existing consumer, and this
    // is the one consumer whose verdict depends on there being a single answer.
    const report = await assuranceRun({
      pkg: await assurancePackage(),
      probeMap: probes({
        claudeList: 'Installed plugins:\n\n  > runtime@agentic-plugins\n    Version: 0.90.2\n    Scope: project\n    Status: enabled\n'
          + '  > runtime@agentic-plugins\n    Version: 0.90.3\n    Scope: user\n    Status: enabled\n',
      }),
    });
    strictEqual(report.host_parity_assurance.status, 'unassured');
    ok(report.host_parity_assurance.evidence.reasons.some((reason) => /ambiguous/.test(reason)));
  });

  it('a NON-AUTHORITATIVE plugin list blocks when a grant applies — partial stdout is not a clean probe', async () => {
    // `observePackages`'s own note places an unreadable host probe in the
    // INTEGRITY layer, while `matchAssurance` can only report it as one
    // membership reason among others. Both are non-coverage; the operator
    // action is what differs, so doctor lifts it.
    const report = await assuranceRun({ pkg: await assurancePackage(), probeMap: probes({ claudeListOk: false }) });
    strictEqual(report.host_parity_assurance.status, 'blocked');
    strictEqual(report.host_parity_assurance.evidence.package_observation.claude.authoritative, false);
    ok(/Repair the installed-plugin listing on claude/.test(report.host_parity_assurance.next_action));
  });

  it('a non-authoritative list does NOT block when no grant applies — CONTROL for the lift above', async () => {
    // The complement, and it is the half that keeps the rule honest. With no
    // grant naming this pair the package facts were never consulted, so telling
    // the operator to repair a probe that changed no verdict would be wrong.
    // This is also the shipped R1 state on every machine: `grants: []`.
    const report = await assuranceRun({ pkg: await assurancePackage({ record: assuranceRecord([]) }), probeMap: probes({ claudeListOk: false }) });
    strictEqual(report.host_parity_assurance.status, 'unassured');
    ok(report.host_parity_assurance.evidence.reasons.some((reason) => /no grant names the host pair/.test(reason)));
  });

  it('a DISABLED install invalidates the grant — the coarse plugin status cannot see this', async () => {
    // ADR-0054 §Decision 9 by name: `summarizePluginStatus`'s
    // `codexListInstalled` counts `decision === 'disabled'` toward `available`,
    // so routing through it would make ADR-0053 §Decision 8's "is disabled"
    // invalidation structurally unable to fire.
    const report = await assuranceRun({
      pkg: await assurancePackage(),
      probeMap: probes({
        codexList: JSON.stringify({ installed: [{ name: 'runtime', marketplaceName: 'agentic-plugins', version: '0.90.3', installed: true, enabled: false }] }),
      }),
    });
    strictEqual(report.host_parity_assurance.status, 'unassured');
    ok(report.host_parity_assurance.evidence.reasons.some((reason) => /disabled/.test(reason)));
    // The proof that this case tests the BYPASS rather than restating the
    // matcher: the coarse status this code refuses to use says otherwise.
    strictEqual(report.plugins.runtime.status, 'available');
  });

  it('an UNKNOWN assurance schema is blocked, not read with the unknown parts ignored', async () => {
    // §Decision 3 names this one explicitly, and the reason is directional: a
    // newer minor could add a NARROWING key, and ignoring it turns a restricted
    // grant into a broad one.
    const pkg = await assurancePackage();
    const text = await readFile(join(pkg, BASELINE_RELATIVE_PATH), 'utf8');
    await writeFile(join(pkg, BASELINE_RELATIVE_PATH), text.replace('"runtime-host-assurance-1.0"', '"runtime-host-assurance-1.1"'));
    const report = await assuranceRun({ pkg });
    strictEqual(report.host_parity_assurance.status, 'blocked');
    strictEqual(report.host_parity_assurance.evidence.record_status, 'unknown-schema');
  });

  it('a probe failure blocks assurance even with a perfect record — no pair, no membership', async () => {
    const map = probes();
    delete map['codex --version'];
    const report = await assuranceRun({ pkg: await assurancePackage(), probeMap: map });
    strictEqual(report.host_parity_assurance.status, 'blocked');
    ok(/Probe host CLIs first/.test(report.host_parity_assurance.next_action));
  });

  it('an UNREADABLE version from a SUCCEEDING probe blocks — exit 0 is not a version', async () => {
    // `probes_ok` is necessary and not sufficient. Without this step `banana`
    // reaches the matcher and comes back `unassured`, which reads as "this
    // machine is not covered" for what is actually an unreadable host probe —
    // and §Decision 3 puts that in the integrity layer.
    const report = await assuranceRun({ pkg: await assurancePackage(), probeMap: probes({ claudeVersion: 'banana' }) });
    strictEqual(report.host_parity_assurance.status, 'blocked');
    ok(/not a version this grammar can read/.test(report.host_parity_assurance.next_action));
  });

  it('a FOUR-COMPONENT version does not match a three-component grant — the measured false-coverage path', async () => {
    // `normalizeVersion` keeps the first three components, so `1.2.3.4`
    // normalizes to `1.2.3` and reads back un-truncated; with the raw-token
    // guards removed this reaches **covered** against a human grant for
    // `1.2.3` (cross-host review, reproduced here by mutation).
    //
    // WHAT THIS CASE ACTUALLY PINS, stated because mutation testing showed the
    // obvious reading is wrong: the guard it exercises is the ladder's
    // probe-usability step, not the matcher's `hosts` input. Mutating the
    // matcher input alone leaves this green — the truncated token is refused
    // one step earlier. Mutating BOTH turns it red with `covered`, which is how
    // the hazard was confirmed to be real rather than theoretical.
    const report = await assuranceRun({
      pkg: await assurancePackage({
        header: 'Observed on 2026-08-16 with Claude Code `1.2.3`, Codex CLI `0.147.0`.\n',
        record: assuranceRecord([grant({ cohort: [{ claude: '1.2.3', codex: OBSERVED.codex }] })]),
      }),
      probeMap: probes({ claudeVersion: '1.2.3.4' }),
    });
    strictEqual(report.host_parity_assurance.status, 'blocked');
    notStrictEqual(report.host_parity_assurance.status, 'covered');
    // And the direction evidence sees it too, rather than reporting `exact`.
    strictEqual(report.host_parity_baseline.evidence.direction.hosts.claude.state, 'unparseable');
  });

  it('the EXACTNESS verdict refuses the four-component false-exact too, and does not call it stale', async () => {
    // The mirror the preceding subtask routed here by name. Before this, the
    // same run reported `baseline-freshness: current` beside
    // `baseline-direction: unparseable` — a report contradicting itself on
    // adjacent lines, which is the opposite of the three-facts split's purpose.
    //
    // `unknown`, not `stale`: the operator action for `stale` names a runtime
    // upgrade or a baseline refresh, and neither is the problem when the HOST
    // printed a version shape the grammar has to truncate.
    const report = await assuranceRun({
      pkg: await assurancePackage({ header: 'Observed on 2026-08-16 with Claude Code `1.2.3`, Codex CLI `0.147.0`.\n' }),
      probeMap: probes({ claudeVersion: '1.2.3.4' }),
    });
    strictEqual(report.host_parity_baseline.status, 'unknown');
    notStrictEqual(report.host_parity_baseline.status, 'current');
    notStrictEqual(report.host_parity_baseline.status, 'stale');
    ok(/more components than this grammar reads/.test(report.host_parity_baseline.next_action));
  });

  it('the exactness verdict still reports a genuine match as current — CONTROL', async () => {
    // Without this, the tightening above is indistinguishable from breaking
    // exactness outright.
    const report = await assuranceRun({
      pkg: await assurancePackage({ header: 'Observed on 2026-08-16 with Claude Code `1.2.3`, Codex CLI `0.147.0`.\n' }),
      probeMap: probes({ claudeVersion: '1.2.3' }),
    });
    strictEqual(report.host_parity_baseline.status, 'current');
    strictEqual(report.host_parity_baseline.next_action, null);
  });

  it('a three-component version DOES match that same grant — CONTROL for the case above', async () => {
    // Without this, the fix above is indistinguishable from "refuse everything".
    const report = await assuranceRun({
      pkg: await assurancePackage({
        header: 'Observed on 2026-08-16 with Claude Code `1.2.3`, Codex CLI `0.147.0`.\n',
        record: assuranceRecord([grant({ cohort: [{ claude: '1.2.3', codex: OBSERVED.codex }] })]),
      }),
      probeMap: probes({ claudeVersion: '1.2.3' }),
    });
    strictEqual(report.host_parity_assurance.status, 'covered');
  });

  it('DIRECTION is recorded and never consulted — a behind machine with a matching grant is still covered', async () => {
    // §Decision 9/10. Direction exists so an operator sees which way the drift
    // runs; promoting it to a coverage input is what the matcher deliberately
    // avoids by not importing the comparator at all.
    const report = await assuranceRun({
      pkg: await assurancePackage({ header: `Observed on 2026-08-16 with Claude Code \`2.1.240\`, Codex CLI \`${OBSERVED.codex}\`.\n` }),
    });
    strictEqual(report.host_parity_baseline.evidence.direction.state, 'behind');
    strictEqual(report.host_parity_baseline.status, 'stale');
    // Exactness says no and assurance says yes, and both are correct. This pair
    // of assertions is the decoupling ADR-0053 exists to produce.
    strictEqual(report.host_parity_assurance.status, 'covered');
  });

  it('one host readable and one not: the PAIR is unparseable, but the readable host keeps its direction', async () => {
    const map = probes();
    delete map['codex --version'];
    const report = await assuranceRun({ pkg: await assurancePackage(), probeMap: map });
    strictEqual(report.host_parity_baseline.evidence.direction.state, 'unparseable');
    // Both are unknown here because the probe gate nulls BOTH observed values
    // when either probe fails — asserted so the coupling is visible rather than
    // assumed to be per-host.
    strictEqual(report.host_parity_baseline.evidence.direction.hosts.codex.state, 'unparseable');
  });

  it('the text renderer mirrors all THREE facts, and names residuals on a covered result', async () => {
    const report = await assuranceRun({
      pkg: await assurancePackage({
        record: assuranceRecord([grant({
          // The grant must BIND the package its residual calls a consumer —
          // measured: naming `attention` while binding only `runtime` makes the
          // record incoherent, which is the semantic contract doing its job
          // (ADR-0053 §Decision 8 ties a consumed surface to a reviewed
          // version). So this case exercises the multi-package binding too.
          packages: { runtime: '0.90.3', attention: '0.9.0' },
          residuals: [{ surface: 'Notification hook payload on Desktop', consumption: 'consumed', disposition: 'probe-pending', consuming_package: 'attention' }],
        })]),
      }),
    });
    const text = formatText(report);
    ok(text.includes('- baseline-freshness: current'));
    ok(text.includes('- baseline-direction: exact'));
    ok(text.includes('- assurance: covered; grant=host-pair-2026-08-16'));
    // §Decision 6 — a `covered` line without the reviewer's caveats drops
    // exactly the part of the review that says what was NOT settled.
    ok(text.includes('residual: Notification hook payload on Desktop'));
  });
});

describe('assurance is REPORTED, not yet gated — the ST3/ST4 scope fence (ADR-0053 §Decision 4)', () => {
  it('flipping assurance from covered to unassured changes NOTHING else in the report or the cutover audit', async () => {
    // Stated as a test rather than a comment, because the failure mode of a
    // fence nobody checks is that it moved. The two packages differ ONLY in the
    // grant's cohort, so every other input to every other verdict is identical.
    const covered = await assuranceRun({ pkg: await assurancePackage() });
    const unassured = await assuranceRun({
      pkg: await assurancePackage({ record: assuranceRecord([grant({ cohort: [{ claude: '9.9.9', codex: '9.9.9' }] })]) }),
    });

    strictEqual(covered.host_parity_assurance.status, 'covered', 'precondition: the two runs really do differ on assurance');
    strictEqual(unassured.host_parity_assurance.status, 'unassured');

    strictEqual(covered.overall.status, unassured.overall.status);
    deepStrictEqual(covered.overall.warnings, unassured.overall.warnings);
    deepStrictEqual(covered.overall.hard_failures, unassured.overall.hard_failures);
    deepStrictEqual(covered.readiness, unassured.readiness);
    strictEqual(covered.experience_parity.score, unassured.experience_parity.score);
    strictEqual(covered.experience_parity.status, unassured.experience_parity.status);
    strictEqual(covered.host_parity_baseline.status, unassured.host_parity_baseline.status);

    const repoRoot = await mkdtemp(join(tmpdir(), 'bcc-assurance-fence-'));
    const coveredAudit = await runCutoverAudit({ repoRoot, doctorReport: covered, now: NOW });
    const unassuredAudit = await runCutoverAudit({ repoRoot, doctorReport: unassured, now: NOW });
    strictEqual(coveredAudit.ready_candidate, unassuredAudit.ready_candidate);
    deepStrictEqual(
      coveredAudit.checks.map((check) => `${check.id}=${check.status}`),
      unassuredAudit.checks.map((check) => `${check.id}=${check.status}`),
    );
    // And the new section is not a check at all yet.
    strictEqual(coveredAudit.checks.some((check) => check.id === 'host_parity_assurance'), false);
  });
});

describe('the assurance ladder as a pure function (ADR-0054 §Decision 4)', () => {
  // The branches `runDoctor` cannot reach deterministically. Cross-host review
  // found the concrete case: the only seam into the doctor builder is
  // `pluginRoot`, so swapping the packaged file between its two reads is a
  // race. As a pure function over injected resolver output it is one call.
  const provenance = (sha) => ({ path: '/pkg/docs/host-parity-baseline.md', content_sha256: sha, runtime_version: '0.90.3' });
  const baselineOk = (sha = 'a'.repeat(64)) => ({
    status: 'resolved',
    baseline: { date: '2026-08-16', claude: OBSERVED.claude, codex: OBSERVED.codex },
    provenance: provenance(sha),
  });
  const recordOk = (sha = 'a'.repeat(64)) => ({
    status: 'resolved',
    record: assuranceRecord(),
    block_sha256: 'b'.repeat(64),
    provenance: provenance(sha),
    baseline_failure: null,
  });
  const probeOk = {
    claude_probe: 'available',
    codex_probe: 'available',
    probes_ok: true,
    observed: { claude: `${OBSERVED.claude} (Claude Code)`, codex: `codex-cli ${OBSERVED.codex}` },
    normalized_observed: { claude: OBSERVED.claude, codex: OBSERVED.codex },
  };
  const observationOk = {
    claude: { authoritative: true, list_status: 'available', packages: { runtime: { present: true, version: '0.90.3', enabled: true, ambiguous: false, observations: 1, source: 'list' } } },
    codex: { authoritative: true, list_status: 'available', packages: { runtime: { present: true, version: '0.90.3', enabled: true, ambiguous: false, observations: 1, source: 'list' } } },
  };
  const evaluate = (over = {}) => evaluateAssurance({
    resolvedBaseline: baselineOk(),
    record: recordOk(),
    pluginSet: PLUGIN_SET,
    probe: probeOk,
    packageObservation: observationOk,
    today: '2026-08-17',
    ...over,
  });

  it('CONTROL: the assembled happy path is covered', () => {
    strictEqual(evaluate().status, 'covered');
  });

  it('two reads that saw different bytes block, even when both parsed cleanly', () => {
    // Deliberately IDENTICAL `block_sha256` on both sides, so a check that
    // compared the block rather than the file would pass here and this case
    // would be vacuous.
    const result = evaluate({ record: { ...recordOk('c'.repeat(64)) } });
    strictEqual(result.status, 'blocked');
    ok(/did not see the same bytes/.test(result.next_action));
  });

  it('a missing content hash on either side blocks rather than comparing two nulls', () => {
    strictEqual(evaluate({ resolvedBaseline: baselineOk(null) }).status, 'blocked');
    strictEqual(evaluate({ record: recordOk(null) }).status, 'blocked');
  });

  it('a SEMANTICALLY invalid plugin set blocks — it is a corrupt package, not an uncovered machine', () => {
    // `loadPluginSet` only resolves and parses; `validatePluginSet` is the half
    // that rejects this, and left to `matchAssurance` the same input comes back
    // `unassured`, which reads as a verdict about the machine.
    const badSet = JSON.parse(JSON.stringify(PLUGIN_SET));
    badSet.plugins.runtime.hosts = ['not-a-host'];
    const result = evaluate({ pluginSet: badSet });
    strictEqual(result.status, 'blocked');
    notStrictEqual(result.status, 'unassured');
    ok(/semantically invalid/.test(result.next_action));
  });

  it('a reader fault is blocked and never silently absent', () => {
    strictEqual(evaluate({ record: null, recordFault: 'schema could not be resolved' }).status, 'blocked');
    strictEqual(evaluate({ pluginSet: null, pluginSetFault: 'plugin-set.json is not valid JSON' }).status, 'blocked');
  });

  it('a future reviewed_at makes the record incoherent, and an incoherent record covers nothing', () => {
    // The injected date is what makes this rule testable at all; reading the
    // clock here would make the case pass or fail by calendar.
    const result = evaluate({ today: '2026-08-15' });
    strictEqual(result.status, 'unassured');
    ok(result.evidence.reasons.some((reason) => /not coherent/.test(reason)));
    // CONTROL: one day later the same record is coherent again.
    strictEqual(evaluate({ today: '2026-08-16' }).status, 'covered');
  });
});

describe('dashboard reports THREE assurance facts and claims the machine one for none of them', () => {
  // `readHostParityBaseline`'s own note says this surface performs no live host
  // probe, so it cannot know which host pair this machine runs. A single
  // `assurance: covered` row here would be read as this machine's answer, which
  // is the precise shape of false assurance the plane exists to prevent.
  const recorded = (status, extra = {}) => ({
    schema_version: 'runtime-host-assurance-result-1.0',
    id: 'host_parity_assurance',
    status,
    evidence: { grant_id: status === 'covered' ? 'host-pair-2026-08-16' : null, direction: { state: 'exact' }, ...extra },
  });

  it('a coherent packaged record is reported as COHERENT, and the machine fact stays not-evaluated', async () => {
    const facts = await readHostAssurance({ repoRoot: '/tmp', pluginRoot: await assurancePackage() });
    strictEqual(facts.authored.status, 'coherent');
    strictEqual(facts.authored.grant_count, 1);
    strictEqual(facts.current_machine.status, 'not-evaluated');
    notStrictEqual(facts.current_machine.status, 'covered');
    // BOTH commands, because they answer different questions and an operator
    // who wanted the second would be misled by only the first.
    ok(/runtime:doctor/.test(facts.current_machine.next_action));
    ok(/--record/.test(facts.current_machine.next_action));
  });

  it('an INCOHERENT record is reported as incoherent, not as "1 grant present"', async () => {
    // The schema was measured accepting eight records that must not be
    // accepted; `granted` + `revoked` over one cohort is one of them. Reporting
    // a grant count here would show authored coverage that covers nothing.
    const facts = await readHostAssurance({
      repoRoot: '/tmp',
      pluginRoot: await assurancePackage({ record: assuranceRecord([grant(), grant({ id: 'withdrawn', state: 'revoked' })]) }),
    });
    strictEqual(facts.authored.status, 'incoherent');
    notStrictEqual(facts.authored.status, 'coherent');
    ok(facts.authored.issues.length > 0, 'and it must say what is wrong');
  });

  it('an EMPTY grant set is coherent and says so — it is the shipped R1 state, not a defect', async () => {
    // ADR-0054 §Decision 6 ships the gate live with `grants: []` on purpose, so
    // the negative path is exercised by the real gate on real machines before
    // any positive is possible. A reader that called this invalid would report
    // a defect on every install.
    const facts = await readHostAssurance({ repoRoot: '/tmp', pluginRoot: await assurancePackage({ record: assuranceRecord([]) }) });
    strictEqual(facts.authored.status, 'coherent');
    strictEqual(facts.authored.grant_count, 0);
    ok(/grants nothing yet/.test(facts.authored.summary));
    // And coherence is NEVER coverage.
    notStrictEqual(facts.current_machine.status, 'covered');
  });

  it('an unreadable packaged record is reported AS that failure, never as coherent', async () => {
    const facts = await readHostAssurance({ repoRoot: '/tmp', pluginRoot: await assurancePackage({ record: null }) });
    strictEqual(facts.authored.status, 'absent');
    notStrictEqual(facts.authored.status, 'coherent');
    ok(facts.authored.next_action, 'the failure must carry an operator action');
  });

  it('a package missing its own schema blocks the read instead of crashing the dashboard', async () => {
    // `resolveAssuranceRecord` throws on a package with no `data/schemas/**`.
    // A read-only surface must not die on a corrupt install.
    const facts = await readHostAssurance({ repoRoot: '/tmp', pluginRoot: await assurancePackage({ withData: false }) });
    strictEqual(facts.authored.status, 'unreadable-package');
  });

  it('an empty pluginRoot override still THROWS — a caller bug must not become a package verdict', async () => {
    // The guard the broad catch would have swallowed: both packaged readers
    // reject an empty override with `TypeError`, and laundering that into
    // `unreadable-package` would hide a programmer error behind a plausible
    // operator-facing status (cross-host review).
    await readHostAssurance({ repoRoot: '/tmp', pluginRoot: '' }).then(
      () => { throw new Error('expected a TypeError for an empty pluginRoot override'); },
      (err) => strictEqual(err.constructor.name, 'TypeError'),
    );
  });

  it('the four RECORDED states stay distinct — no artifact, legacy, readable, unreadable', async () => {
    // Collapsing any pair loses an operator action. The first version of this
    // reader reported "the recorded report predates the section" for a
    // repository that had never recorded one, asserting something about a
    // document that does not exist.
    const pkg = await assurancePackage();
    const read = async (recordedAssurance) => (await readHostAssurance({ repoRoot: '/tmp', pluginRoot: pkg, recordedAssurance })).recorded;

    strictEqual((await read(null)).status, 'no-recorded-run');
    strictEqual((await read(projectRecordedAssurance({ schema_version: 'runtime-doctor-1.0' }))).status, 'legacy-unassured');
    const covered = await read(projectRecordedAssurance({ schema_version: 'runtime-doctor-1.0', host_parity_assurance: recorded('covered') }));
    strictEqual(covered.status, 'covered');
    strictEqual(covered.grant_id, 'host-pair-2026-08-16');
    strictEqual((await read(projectRecordedAssurance({ host_parity_assurance: { ...recorded('covered'), schema_version: 'runtime-host-assurance-result-1.1' } }))).status, 'unreadable');
    // A `covered` the producer cannot emit — no grant id — is refused rather
    // than trusted, because it is either corrupt or from a producer this reader
    // does not understand, and both are non-coverage.
    strictEqual((await read(projectRecordedAssurance({ host_parity_assurance: { ...recorded('covered'), evidence: {} } }))).status, 'unreadable');
    // CONTROL: a non-covered producer status is carried verbatim, so the reader
    // is not simply refusing everything it is handed.
    strictEqual((await read(projectRecordedAssurance({ host_parity_assurance: recorded('blocked') }))).status, 'blocked');
  });

  it('a MALFORMED newest artifact reports unreadable, not legacy — nothing in it was read', async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), 'bcc-assurance-dash-'));
    const dir = join(repoRoot, '.agentic-plugins', 'runs', 'doctor', 'doctor-20260817T000000Z-aaaaaa');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'doctor.json'), JSON.stringify({ schema_version: 'runtime-doctor-artifact-1.0', run_id: 'doctor-20260817T000000Z-aaaaaa', report: { schema_version: 'runtime-doctor-9.9' } }));

    const report = await buildDashboardReport({ repoRoot, homeDir: await mkdtemp(join(tmpdir(), 'bcc-assurance-home-')), pluginRoot: await assurancePackage() });
    strictEqual(report.tier2.doctor.status, 'blocked');
    strictEqual(report.tier2.assurance.recorded.status, 'unreadable');
    notStrictEqual(report.tier2.assurance.recorded.status, 'legacy-unassured');
    // The schema family bumped for this additive section; the doctor report
    // family deliberately did not, and the asymmetry is recorded at both sites.
    strictEqual(report.schema_version, 'runtime-dashboard-1.3');
  });

  it('the dashboard text renders three assurance rows, and none of them claims this machine', async () => {
    const report = await buildDashboardReport({
      repoRoot: await mkdtemp(join(tmpdir(), 'bcc-assurance-dash-')),
      homeDir: await mkdtemp(join(tmpdir(), 'bcc-assurance-home-')),
      pluginRoot: await assurancePackage(),
    });
    const text = renderDashboardText(report);
    ok(text.includes('- assurance (authored record): coherent'));
    ok(text.includes('- assurance (latest recorded doctor): no-recorded-run'));
    ok(text.includes('- assurance (this machine): not-evaluated'));
    // The row that must never appear on this surface.
    strictEqual(/- assurance: covered/.test(text), false);
  });
});
