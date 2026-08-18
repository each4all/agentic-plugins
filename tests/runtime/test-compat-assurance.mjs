// tests/runtime/test-compat-assurance.mjs
//
// ADR-0053 §Decision 2/§Decision 4/§Decision 11 — compat observes assurance,
// freezes it, and every reader of the persisted artifact projects it fail-closed.
//
// THE CONTROL IS NOT DECORATION. Every negative below would also pass against an
// implementation hard-wired to return `unassured`, so each group carries a case
// that MUST reach coverage. Where a control is missing the suite says so.

import { deepStrictEqual, ok, strictEqual } from 'node:assert';
import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  COMPAT_GAP_SCHEMA,
  COMPAT_GAP_STATUSES,
  COMPAT_SNAPSHOT_SCHEMA,
  READY_COMPAT_STATUSES,
  projectGapFamily,
} from '../../plugins/runtime/scripts/lib/compat-artifacts.mjs';
import { inspectCompatRuns } from '../../plugins/runtime/scripts/lib/state-readers.mjs';
import { runCompat } from '../../plugins/runtime/scripts/compat.mjs';
import { canonicalJson, loadSchema } from '../../plugins/runtime/scripts/lib/schema-validate.mjs';

const RUNTIME_PLUGIN_ROOT = new URL('../../plugins/runtime/', import.meta.url).pathname;
// The installed runtime the fixtures report is the ADR-0054 §Decision 5 FLOOR,
// not an arbitrary value: below it the floor refuses the machine as an integrity
// failure one step above membership, so an older fixture would report `blocked`
// in every case that means to exercise coverage.
const RUN_ID = 'compat-20260516T000000Z-abcdef';
const NOW = new Date('2026-08-18T00:00:00.000Z');
// The pair the fixtures observe. It is NOT this machine's pair — a fixture that
// happened to match the developer's hosts would pass for a reason no assertion
// names.
const OBSERVED = { claude: '2.1.141', codex: '0.130.0' };
const OBSERVED_TEXT = { claude: '2.1.141 (Claude Code)', codex: 'codex-cli 0.130.0' };
const ASSURANCE_SCHEMA = await loadSchema('runtime-host-assurance', { pluginRoot: RUNTIME_PLUGIN_ROOT });

const baseline = () => ({
  claude: { version: OBSERVED.claude },
  codex: { version: OBSERVED.codex },
  provenance: { status: 'resolved' },
});
const driftedBaseline = () => ({
  claude: { version: '2.0.0' },
  codex: { version: '0.100.0' },
  provenance: { status: 'resolved' },
});

const ok0 = (stdout = '') => ({ ok: true, exit_code: 0, stdout, stderr: '', error_code: null, timed_out: false });

/**
 * A runner that answers the version probes AND the plugin listings.
 *
 * ⚠ MEASURED FIXTURE SHAPE, not invented: `parseClaudePluginList`'s leading
 * `\S?` consumes the `>` marker real output carries, so a fixture without it
 * parses the plugin name as `untime` and every membership case then fails for
 * the wrong reason.
 */
function hostRunner({ claudeListOk = true, codexListOk = true } = {}) {
  const claudeText = 'Installed plugins:\n\n  > runtime@agentic-plugins\n    Version: 0.91.0\n    Scope: user\n    Status: enabled\n';
  const codexJson = JSON.stringify({
    installed: [{ name: 'runtime', marketplaceName: 'agentic-plugins', version: '0.91.0', installed: true, enabled: true }],
  });
  return async (command, args) => {
    const key = `${command} ${args.join(' ')}`;
    if (args[0] === '--version') return ok0(`${OBSERVED_TEXT[command]}\n`);
    if (key === 'claude plugin list') {
      return claudeListOk
        ? ok0(claudeText)
        // A FAILED command that still printed usable-looking rows. `observePackages`
        // must read the STATUS, not the rows.
        : { ok: false, exit_code: 1, stdout: claudeText, stderr: 'boom', error_code: null, timed_out: false };
    }
    if (key === 'codex plugin list --json') {
      return codexListOk ? ok0(codexJson) : ok0('not json at all');
    }
    return ok0(`${key} help text\n`);
  };
}

const grant = (patch = {}) => ({
  id: 'compat-fixture-grant',
  state: 'granted',
  reviewed_at: '2026-08-16',
  review_provenance: { kind: 'adr', reference: 'ADR-0054' },
  cohort: [{ claude: OBSERVED.claude, codex: OBSERVED.codex }],
  packages: { runtime: '0.91.0' },
  residuals: [],
  ...patch,
});

/** A fixture PACKAGE carrying a baseline header, an optional grant, and real `data/`. */
async function fixturePackage({ grants = [], header = null } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'compat-assurance-pkg-'));
  await mkdir(join(root, 'docs'), { recursive: true });
  await mkdir(join(root, '.claude-plugin'), { recursive: true });
  await writeFile(join(root, '.claude-plugin', 'plugin.json'), JSON.stringify({ version: '0.91.0' }));
  // The REAL `data/`: the schema decides whether a record validates and the
  // plugin set decides which hosts a package binding must hold on, so a fixture
  // copy of either would test rules the shipped package does not have.
  await cp(join(RUNTIME_PLUGIN_ROOT, 'data'), join(root, 'data'), { recursive: true });
  const head = header ?? `Observed on 2026-08-16 with Claude Code \`${OBSERVED.claude}\`, Codex CLI \`${OBSERVED.codex}\`.\n`;
  const record = { schema: 'runtime-host-assurance-1.0', grants };
  const block = `\n<!-- BEGIN COMPATIBILITY ASSURANCE -->\n\`\`\`json\n${canonicalJson(record, ASSURANCE_SCHEMA)}\`\`\`\n<!-- END COMPATIBILITY ASSURANCE -->\n`;
  await writeFile(join(root, 'docs/host-parity-baseline.md'), `${head}${block}`);
  return root;
}

async function repo() {
  const root = await mkdtemp(join(tmpdir(), 'compat-assurance-repo-'));
  await writeFile(join(root, '.release-please-manifest.json'), JSON.stringify({ 'plugins/runtime': '0.91.0' }));
  return root;
}

const readJson = async (path) => JSON.parse(await readFile(path, 'utf8'));

/**
 * Snapshot + check in one call, with EVERY environment input threaded.
 *
 * ⚠ `homeDir`/`codexHome`/`env` are passed explicitly and this is the point of
 * the helper: `probeMachineHostState` otherwise reads the real home directory,
 * the real `process.env` and the real `CODEX_HOME`, so a suite that injected
 * only a runner would inspect the developer's own caches — hermetic by accident,
 * and only until someone's machine differs.
 */
async function snapshotAndCheck({ root, pluginRoot, baseline: base = baseline(), runner = hostRunner(), env = {} }) {
  const isolatedHome = await mkdtemp(join(tmpdir(), 'compat-assurance-home-'));
  const common = {
    repoRoot: root,
    runId: RUN_ID,
    now: NOW,
    baseline: base,
    runner,
    pluginRoot,
    homeDir: isolatedHome,
    codexHome: join(isolatedHome, '.codex'),
    env,
  };
  const snapshot = await runCompat({ command: 'snapshot', ...common });
  const check = await runCompat({ command: 'check', ...common });
  const gap = await readJson(join(root, `.agentic-plugins/runs/compat/${RUN_ID}/gap-analysis.json`));
  const snap = await readJson(join(root, `.agentic-plugins/runs/compat/${RUN_ID}/snapshot.json`));
  return { snapshot, check, gap, snap };
}

// ---------------------------------------------------------------------------
// ST5 — the audit of the assembled plane measured three gaps in compat's
// OBSERVATION half. The projection half below was already correct; these are
// its producer-side mirrors.
// ---------------------------------------------------------------------------

describe('ST5: a FAILED version probe is not a reading of the host', () => {
  // `observeHost` fills `.version` from stdout OR stderr regardless of exit
  // status, and the probe status was derived from that field. So a
  // `claude --version` that exits non-zero after printing version-shaped text
  // arrived as `available`, and the ladder permitted coverage from a probe that
  // failed — while doctor's symmetric path preserved the command status.
  const failingVersion = (host) => async (command, args) => {
    const base = hostRunner();
    if (args[0] === '--version' && command === host) {
      return { ok: false, exit_code: 1, stdout: `${OBSERVED_TEXT[host]}\n`, stderr: 'boom', error_code: null, timed_out: false };
    }
    return base(command, args);
  };

  it('CONTROL: with both probes succeeding the fixture grant covers', async () => {
    const { gap } = await snapshotAndCheck({ root: await repo(), pluginRoot: await fixturePackage({ grants: [grant()] }) });
    strictEqual(gap.overall.assurance.status, 'covered');
  });

  for (const host of ['claude', 'codex']) {
    it(`a non-zero ${host} --version that still prints a version blocks, never covers`, async () => {
      const { gap } = await snapshotAndCheck({
        root: await repo(),
        pluginRoot: await fixturePackage({ grants: [grant()] }),
        runner: failingVersion(host),
      });
      strictEqual(gap.overall.assurance.status, 'blocked');
      ok(!READY_COMPAT_STATUSES.includes(gap.overall.status),
        `a failed probe must not reach a ready status (got ${gap.overall.status})`);
    });
  }
});

describe('ST5: the snapshot FAMILY decides whether its assurance section is read', () => {
  // `lib/compat-artifacts.mjs` already applies this rule to the GAP artifact,
  // and its comment records the measurement that forced it: "a `1.0` artifact
  // carrying a hand-added assurance block read as `readable`, so an edited
  // legacy file could inject a `covered` verdict". The READER side was fixed and
  // the PRODUCER side was not — re-running `check` over a doctored SNAPSHOT
  // minted a fresh, protected-looking 1.1 gap saying `current`.
  async function checkOverDoctoredSnapshot(patch) {
    const root = await repo();
    const pluginRoot = await fixturePackage({ grants: [grant()] });
    const isolatedHome = await mkdtemp(join(tmpdir(), 'compat-assurance-home-'));
    const common = {
      repoRoot: root,
      runId: RUN_ID,
      now: NOW,
      baseline: baseline(),
      runner: hostRunner(),
      pluginRoot,
      homeDir: isolatedHome,
      codexHome: join(isolatedHome, '.codex'),
      env: {},
    };
    await runCompat({ command: 'snapshot', ...common });
    const snapshotPath = join(root, `.agentic-plugins/runs/compat/${RUN_ID}/snapshot.json`);
    const snapshot = JSON.parse(await readFile(snapshotPath, 'utf8'));
    await writeFile(snapshotPath, JSON.stringify({ ...snapshot, ...patch }, null, 2));
    await runCompat({ command: 'check', ...common });
    return readJson(join(root, `.agentic-plugins/runs/compat/${RUN_ID}/gap-analysis.json`));
  }

  it('CONTROL: the shipped family with a genuine covered section reaches current', async () => {
    const gap = await checkOverDoctoredSnapshot({});
    strictEqual(gap.overall.assurance_state, 'readable');
    strictEqual(gap.overall.status, 'current');
  });

  it('a PRE-DECISION 1.0 snapshot carrying a covered block is legacy, never coverage', async () => {
    const gap = await checkOverDoctoredSnapshot({ schema_version: 'runtime-compat-snapshot-1.0' });
    strictEqual(gap.overall.assurance_state, 'legacy');
    strictEqual(gap.overall.status, 'legacy_unassured');
    ok(!READY_COMPAT_STATUSES.includes(gap.overall.status));
  });

  it('an UNKNOWN future family is unreadable, not legacy — a narrowing field would go unread', async () => {
    const gap = await checkOverDoctoredSnapshot({ schema_version: 'runtime-compat-snapshot-1.2' });
    strictEqual(gap.overall.assurance_state, 'unreadable');
    ok(!READY_COMPAT_STATUSES.includes(gap.overall.status));
  });
});

describe('ST5: the assurance machine probe never runs inside the repository', () => {
  it('the plugin listings are probed from a NEUTRAL directory', async () => {
    // `lib/machine-probe.mjs` states the invariant in its header — "host CLIs
    // never run inside the caller's repository, so a repo-local plugin scope
    // cannot leak into a machine answer". doctor.mjs and bootstrap.mjs both pass
    // tmpdir(); compat passed repoRoot, and compat's frozen assurance therefore
    // could describe a machine state the two gating consumers cannot see.
    const root = await repo();
    const seen = [];
    const base = hostRunner();
    const recordingRunner = async (command, args, options = {}) => {
      seen.push({ key: `${command} ${args.join(' ')}`, cwd: options.cwd ?? null });
      return base(command, args, options);
    };
    await snapshotAndCheck({ root, pluginRoot: await fixturePackage({ grants: [grant()] }), runner: recordingRunner });
    const listings = seen.filter((call) => call.key.includes('plugin list'));
    ok(listings.length > 0, 'the fixture must actually probe the plugin listings');
    for (const call of listings) {
      ok(call.cwd !== root, `${call.key} must not be probed from the repository root`);
    }
  });
});

// ---------------------------------------------------------------------------
describe('compat artifact family projection is fail-closed and schema-decided', () => {
  // `assurance_state` is what the 1.1 contract requires; `assurance` is the
  // result and is null exactly when the state is `legacy`.
  const gapOf = (schema, extra = {}) => ({ schema_version: schema, overall: { status: 'current', assurance_state: 'readable', ...extra } });

  it('CONTROL: the shipped schema carrying a section is readable', () => {
    strictEqual(projectGapFamily(gapOf(COMPAT_GAP_SCHEMA, { assurance: { status: 'covered' } })).kind, 'readable');
  });

  it('the 1.0 history this repository actually has is legacy, never coverage', () => {
    strictEqual(projectGapFamily(gapOf('runtime-compat-gap-1.0')).kind, 'legacy');
  });

  it('a 1.0 artifact carrying a FORGED assurance section stays legacy', () => {
    // The schema decides whether a section may be read, never the section's own
    // presence. Otherwise an edited legacy file injects a `covered` verdict into
    // a plane whose whole purpose is that only a human grant produces one.
    const forged = gapOf('runtime-compat-gap-1.0', { assurance: { status: 'covered', evidence: { grant_id: 'forged' } } });
    strictEqual(projectGapFamily(forged).kind, 'legacy');
  });

  it('a FUTURE MINOR is refused, because a narrowing field would go unread', () => {
    // This is the case a "known major" check accepts. A minor may add a
    // condition that RESTRICTS what a verdict covers, and skipping the field
    // this reader has never heard of turns a restricted verdict into an
    // unrestricted one.
    strictEqual(projectGapFamily(gapOf('runtime-compat-gap-1.2', { assurance: { status: 'covered' } })).kind, 'unrecognized');
    strictEqual(projectGapFamily(gapOf('runtime-compat-gap-2.0')).kind, 'unrecognized');
  });

  it('a shipped-schema artifact MISSING its required state is incomplete, not historical', () => {
    const bare = { schema_version: COMPAT_GAP_SCHEMA, overall: { status: 'current' } };
    strictEqual(projectGapFamily(bare).kind, 'unrecognized');
    strictEqual(projectGapFamily({ schema_version: COMPAT_GAP_SCHEMA, overall: { status: 'current', assurance_state: 'future' } }).kind, 'unrecognized');
  });

  it('a shipped-schema artifact declaring `legacy` is history, and its null result is CORRECT', () => {
    // The producer writes exactly this for a pre-decision snapshot. An earlier
    // draft asked whether the RESULT object was present and called this shape
    // incomplete, so the runtime refused a run it had just written.
    const legacy = { schema_version: COMPAT_GAP_SCHEMA, overall: { status: 'legacy_unassured', assurance: null, assurance_state: 'legacy' } };
    strictEqual(projectGapFamily(legacy).kind, 'legacy');
  });

  it('a non-string or absent schema is refused rather than coerced', () => {
    strictEqual(projectGapFamily({ schema_version: 7 }).kind, 'unrecognized');
    strictEqual(projectGapFamily({}).kind, 'unrecognized');
    strictEqual(projectGapFamily(null).kind, 'unrecognized');
  });

  it('the ready list is a strict subset of the producer vocabulary', () => {
    for (const status of READY_COMPAT_STATUSES) ok(COMPAT_GAP_STATUSES.includes(status), `${status} must be a producer status`);
    // Exactly two positives. A third would mean some non-covered state started
    // reading as healthy.
    deepStrictEqual([...READY_COMPAT_STATUSES], ['current', 'assured']);
  });
});

// ---------------------------------------------------------------------------
describe('compat observes assurance and NEVER grants it', () => {
  it('CONTROL: a grant naming the observed pair reaches covered, and no drift means current', async () => {
    const { gap, snap } = await snapshotAndCheck({ root: await repo(), pluginRoot: await fixturePackage({ grants: [grant()] }) });
    strictEqual(snap.schema_version, COMPAT_SNAPSHOT_SCHEMA);
    strictEqual(snap.host_assurance.status, 'covered');
    strictEqual(gap.overall.status, 'current');
    strictEqual(gap.overall.drift_class, 'none');
    strictEqual(gap.overall.assurance.evidence.grant_id, 'compat-fixture-grant');
  });

  it('drift a human granted reports `assured` while the drift stays visible as evidence', async () => {
    const { gap } = await snapshotAndCheck({
      root: await repo(),
      pluginRoot: await fixturePackage({ grants: [grant()] }),
      baseline: driftedBaseline(),
    });
    strictEqual(gap.overall.status, 'assured');
    // §Decision 4 moves the CLASSIFICATION, not the evidence.
    strictEqual(gap.overall.drift_class, 'host-version-changed');
    ok(gap.host_gaps.some((row) => row.status === 'version_changed'));
  });

  it('the shipped empty grant set reports unassured — R1 ships this state on purpose', async () => {
    const { gap } = await snapshotAndCheck({ root: await repo(), pluginRoot: await fixturePackage({ grants: [] }) });
    strictEqual(gap.overall.status, 'unassured');
    ok(!READY_COMPAT_STATUSES.includes(gap.overall.status));
  });

  it('a revoked grant is unassured, not covered — negative wins', async () => {
    const { gap } = await snapshotAndCheck({
      root: await repo(),
      pluginRoot: await fixturePackage({ grants: [grant(), grant({ id: 'compat-fixture-grant', state: 'revoked', reviewed_at: '2026-08-17' })] }),
    });
    ok(gap.overall.status !== 'current' && gap.overall.status !== 'assured', `revoked grant produced ${gap.overall.status}`);
  });

  it('a non-authoritative Claude listing next to an applying grant blocks, and does NOT silently cover', async () => {
    const { gap } = await snapshotAndCheck({
      root: await repo(),
      pluginRoot: await fixturePackage({ grants: [grant()] }),
      runner: hostRunner({ claudeListOk: false }),
    });
    strictEqual(gap.overall.status, 'assurance_blocked');
    // The evaluator's own repair line survives into the artifact — a blocked
    // state with a generic next step is the defect this stored field prevents.
    // The line now comes from the ADR-0054 §Decision 5 floor, which also decides
    // from the installed-plugin listing and is ordered above membership; it names
    // the same thing to repair.
    ok(gap.next_steps[0].includes('installed-plugin list was not authoritative'), gap.next_steps[0]);
  });

  it('a drifted pair with no grant keeps its planning state rather than borrowing a new one', async () => {
    const { gap } = await snapshotAndCheck({
      root: await repo(),
      pluginRoot: await fixturePackage({ grants: [] }),
      baseline: driftedBaseline(),
    });
    // Release notes are required first; that ordering is unchanged for the
    // uncovered path.
    ok(['release_notes_required', 'gap_analysis_ready'].includes(gap.overall.status), gap.overall.status);
  });
});

// ---------------------------------------------------------------------------
describe('a remembered snapshot is never retroactively granted assurance', () => {
  it('re-checking an OLD snapshot after a grant ships does not turn it covered', async () => {
    // THE POINT OF FREEZING. Without it, `check` re-evaluates against the
    // then-installed record, so a six-week-old observation becomes `covered` the
    // day a release ships a grant — coverage awarded to a machine state nobody
    // reviewed, through the one command an operator runs casually.
    const root = await repo();
    const ungranted = await fixturePackage({ grants: [] });
    const granted = await fixturePackage({ grants: [grant()] });
    const isolatedHome = await mkdtemp(join(tmpdir(), 'compat-assurance-home-'));
    const common = {
      repoRoot: root, runId: RUN_ID, now: NOW, baseline: baseline(), runner: hostRunner(),
      homeDir: isolatedHome, codexHome: join(isolatedHome, '.codex'), env: {},
    };
    await runCompat({ command: 'snapshot', ...common, pluginRoot: ungranted });
    const before = await runCompat({ command: 'check', ...common, pluginRoot: ungranted });
    strictEqual(before.status, 'unassured');

    // The grant ships. Only the PACKAGE changed; the snapshot is untouched.
    const after = await runCompat({ command: 'check', ...common, pluginRoot: granted });
    strictEqual(after.status, 'unassured', 'the frozen verdict must survive a package that now grants');

    // CONTROL, and it is what proves the fixture could have flipped: a FRESH
    // snapshot against the same granting package does reach coverage.
    const fresh = { ...common, runId: 'compat-20260516T000001Z-abcdef', pluginRoot: granted };
    await runCompat({ command: 'snapshot', ...fresh });
    strictEqual((await runCompat({ command: 'check', ...fresh })).status, 'current');
  });

  it('a snapshot with no assurance section is legacy, and asks for a fresh snapshot', async () => {
    const root = await repo();
    const pluginRoot = await fixturePackage({ grants: [grant()] });
    const isolatedHome = await mkdtemp(join(tmpdir(), 'compat-assurance-home-'));
    const common = {
      repoRoot: root, runId: RUN_ID, now: NOW, baseline: baseline(), runner: hostRunner(), pluginRoot,
      homeDir: isolatedHome, codexHome: join(isolatedHome, '.codex'), env: {},
    };
    await runCompat({ command: 'snapshot', ...common });
    // Rewrite the snapshot as pre-decision history — the shape of all 34
    // artifacts this repository actually has on disk.
    const snapPath = join(root, `.agentic-plugins/runs/compat/${RUN_ID}/snapshot.json`);
    const snap = await readJson(snapPath);
    delete snap.host_assurance;
    snap.schema_version = 'runtime-compat-snapshot-1.0';
    await writeFile(snapPath, `${JSON.stringify(snap, null, 2)}\n`);

    const check = await runCompat({ command: 'check', ...common });
    strictEqual(check.status, 'legacy_unassured', 'a package that grants must not rescue a pre-decision snapshot');
    ok(check.next_steps[0].includes('runtime:compat snapshot'), check.next_steps[0]);
  });

  it('ROUND TRIP: what check reports is what re-reading the artifact reports', async () => {
    // ⚠ THE CHECK THIS SUITE ORIGINALLY LACKED, and the gap was not theoretical:
    // cross-host review measured the producer reporting `legacy_unassured` while
    // the very same bytes read back `unrecognized / blocked` — a run this runtime
    // had just written, refused by the runtime that wrote it. Every case above
    // tested one side or the other; none crossed the boundary, so a contradiction
    // between them was invisible to all 32 of them.
    const root = await repo();
    const pluginRoot = await fixturePackage({ grants: [grant()] });
    const isolatedHome = await mkdtemp(join(tmpdir(), 'compat-assurance-home-'));
    const common = {
      repoRoot: root, runId: RUN_ID, now: NOW, baseline: baseline(), runner: hostRunner(), pluginRoot,
      homeDir: isolatedHome, codexHome: join(isolatedHome, '.codex'), env: {},
    };
    await runCompat({ command: 'snapshot', ...common });

    // Case 1 — the fresh, covered run.
    const fresh = await runCompat({ command: 'check', ...common });
    strictEqual((await inspectCompatRuns({ repoRoot: root })).latest.status, fresh.status);

    // Case 2 — the pre-decision snapshot, which is where the contradiction was.
    const snapPath = join(root, `.agentic-plugins/runs/compat/${RUN_ID}/snapshot.json`);
    const snap = await readJson(snapPath);
    delete snap.host_assurance;
    await writeFile(snapPath, `${JSON.stringify(snap, null, 2)}\n`);
    const legacy = await runCompat({ command: 'check', ...common });
    strictEqual(legacy.status, 'legacy_unassured');
    strictEqual((await inspectCompatRuns({ repoRoot: root })).latest.status, legacy.status);

    // Case 3 — the unreadable frozen result.
    const snap2 = await readJson(snapPath);
    snap2.host_assurance = { schema_version: 'runtime-host-assurance-result-9.9', status: 'covered' };
    await writeFile(snapPath, `${JSON.stringify(snap2, null, 2)}\n`);
    const blocked = await runCompat({ command: 'check', ...common });
    strictEqual(blocked.status, 'assurance_blocked');
    strictEqual((await inspectCompatRuns({ repoRoot: root })).latest.status, blocked.status);
  });

  it('an advisory plan never demotes a run the gap already called ready', async () => {
    // An assured host drifts by definition, so its plan is `actionable` and the
    // informational carve-out cannot save it. Measured before the fix: one
    // `compat plan` run moved an `assured` host to `plan_ready / needs_attention`
    // permanently. The ADR-0047 §5 protection was keyed on the literal `current`
    // and so never reached the status this plane added.
    const root = await repo();
    const pluginRoot = await fixturePackage({ grants: [grant()] });
    const isolatedHome = await mkdtemp(join(tmpdir(), 'compat-assurance-home-'));
    const common = {
      repoRoot: root, runId: RUN_ID, now: NOW, baseline: driftedBaseline(), runner: hostRunner(), pluginRoot,
      homeDir: isolatedHome, codexHome: join(isolatedHome, '.codex'), env: {},
    };
    await runCompat({ command: 'snapshot', ...common });
    strictEqual((await runCompat({ command: 'check', ...common })).status, 'assured');
    const before = await inspectCompatRuns({ repoRoot: root });
    strictEqual(before.latest.status, 'assured');

    await runCompat({ command: 'plan', ...common });
    const after = await inspectCompatRuns({ repoRoot: root });
    strictEqual(after.latest.status, 'assured', 'an advisory plan must not demote a ready run');
    strictEqual(after.status, 'available');
    // CONTROL: a run the gap did NOT call ready still reaches plan_ready, so the
    // fix narrowed the plan branch rather than deleting it.
    ok(after.latest.next_steps.length > 0);
  });

  it('an UNREADABLE frozen result blocks rather than degrading to legacy', async () => {
    // The two call for opposite actions — upgrade versus re-snapshot — so
    // collapsing them loses the operator's move.
    const root = await repo();
    const pluginRoot = await fixturePackage({ grants: [grant()] });
    const isolatedHome = await mkdtemp(join(tmpdir(), 'compat-assurance-home-'));
    const common = {
      repoRoot: root, runId: RUN_ID, now: NOW, baseline: baseline(), runner: hostRunner(), pluginRoot,
      homeDir: isolatedHome, codexHome: join(isolatedHome, '.codex'), env: {},
    };
    await runCompat({ command: 'snapshot', ...common });
    const snapPath = join(root, `.agentic-plugins/runs/compat/${RUN_ID}/snapshot.json`);
    const snap = await readJson(snapPath);
    snap.host_assurance.schema_version = 'runtime-host-assurance-result-9.9';
    await writeFile(snapPath, `${JSON.stringify(snap, null, 2)}\n`);
    strictEqual((await runCompat({ command: 'check', ...common })).status, 'assurance_blocked');
  });

  it('a `covered` result with no grant id blocks — the producer cannot emit it', async () => {
    const root = await repo();
    const pluginRoot = await fixturePackage({ grants: [] });
    const isolatedHome = await mkdtemp(join(tmpdir(), 'compat-assurance-home-'));
    const common = {
      repoRoot: root, runId: RUN_ID, now: NOW, baseline: baseline(), runner: hostRunner(), pluginRoot,
      homeDir: isolatedHome, codexHome: join(isolatedHome, '.codex'), env: {},
    };
    await runCompat({ command: 'snapshot', ...common });
    const snapPath = join(root, `.agentic-plugins/runs/compat/${RUN_ID}/snapshot.json`);
    const snap = await readJson(snapPath);
    snap.host_assurance.status = 'covered';
    delete snap.host_assurance.evidence.grant_id;
    await writeFile(snapPath, `${JSON.stringify(snap, null, 2)}\n`);
    strictEqual((await runCompat({ command: 'check', ...common })).status, 'assurance_blocked');
  });
});

// ---------------------------------------------------------------------------
describe('precedence: integrity outranks history outranks coverage outranks planning', () => {
  // ⚠ ORDER, not existence. Deleting a branch proves it exists; only a COLLISION
  // proves it is ranked correctly. Each row below sets up two competing facts.
  const rows = [
    { label: 'broken baseline + a grant that would cover', expect: 'baseline_unusable' },
    { label: 'unreadable frozen result + a grant that would cover', expect: 'assurance_blocked' },
    { label: 'legacy snapshot + a grant that would cover', expect: 'legacy_unassured' },
    { label: 'covered + release notes missing on drift', expect: 'assured' },
  ];

  for (const row of rows) {
    it(row.label, async () => {
      const root = await repo();
      const pluginRoot = await fixturePackage({ grants: [grant()] });
      const isolatedHome = await mkdtemp(join(tmpdir(), 'compat-assurance-home-'));
      const drifted = row.expect === 'assured';
      const common = {
        repoRoot: root, runId: RUN_ID, now: NOW, runner: hostRunner(), pluginRoot,
        homeDir: isolatedHome, codexHome: join(isolatedHome, '.codex'), env: {},
        baseline: drifted ? driftedBaseline() : baseline(),
      };
      await runCompat({ command: 'snapshot', ...common });
      const snapPath = join(root, `.agentic-plugins/runs/compat/${RUN_ID}/snapshot.json`);

      if (row.expect === 'assurance_blocked') {
        const snap = await readJson(snapPath);
        snap.host_assurance.schema_version = 'runtime-host-assurance-result-9.9';
        await writeFile(snapPath, `${JSON.stringify(snap, null, 2)}\n`);
      }
      if (row.expect === 'legacy_unassured') {
        const snap = await readJson(snapPath);
        delete snap.host_assurance;
        await writeFile(snapPath, `${JSON.stringify(snap, null, 2)}\n`);
      }
      const checkOpts = row.expect === 'baseline_unusable'
        // A baseline the resolver could not use. Nothing was compared, so no
        // readiness answer — not even a granted one — is honest.
        ? { ...common, baseline: { claude: { version: null }, codex: { version: null }, provenance: { status: 'unreadable' } } }
        : common;
      strictEqual((await runCompat({ command: 'check', ...checkOpts })).status, row.expect);
    });
  }
});

// ---------------------------------------------------------------------------
describe('state-readers project every new status without falling through', () => {
  async function runWithGap(gapPatch, { snapshotSchema = COMPAT_SNAPSHOT_SCHEMA } = {}) {
    const root = await mkdtemp(join(tmpdir(), 'compat-readers-'));
    const dir = join(root, '.agentic-plugins/runs/compat', RUN_ID);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'snapshot.json'), JSON.stringify({
      schema_version: snapshotSchema, run_id: RUN_ID,
      created_at: '2026-08-18T00:00:00Z', updated_at: '2026-08-18T00:00:00Z',
      hosts: { claude: { version: OBSERVED.claude }, codex: { version: OBSERVED.codex } },
    }));
    await writeFile(join(dir, 'gap-analysis.json'), JSON.stringify({
      schema_version: COMPAT_GAP_SCHEMA, run_id: RUN_ID,
      overall: { status: 'current', drift_class: 'none', release_notes_required: false, assurance: { status: 'covered' }, assurance_state: 'readable' },
      host_gaps: [], next_steps: ['stored step'],
      ...gapPatch,
    }));
    return inspectCompatRuns({ repoRoot: root });
  }

  const expectations = [
    { status: 'current', run: 'current', collection: 'available' },
    { status: 'assured', run: 'assured', collection: 'available' },
    { status: 'unassured', run: 'unassured', collection: 'needs_attention' },
    { status: 'assurance_blocked', run: 'assurance_blocked', collection: 'blocked' },
    { status: 'baseline_unusable', run: 'baseline_unusable', collection: 'blocked' },
    { status: 'release_notes_required', run: 'release_notes_required', collection: 'release_notes_required' },
    { status: 'gap_analysis_ready', run: 'gap_analysis_ready', collection: 'needs_attention' },
  ];

  for (const row of expectations) {
    it(`${row.status} projects to ${row.run} / ${row.collection}`, async () => {
      const out = await runWithGap({
        overall: { status: row.status, drift_class: 'none', release_notes_required: false, assurance: { status: 'covered' }, assurance_state: 'readable' },
      });
      strictEqual(out.latest.status, row.run);
      strictEqual(out.status, row.collection);
      ok(out.latest.next_steps.length > 0, 'every status must carry a next step — silence reads as nothing to do');
    });
  }

  it('EVERY producer status is projected — none reaches the unrecognized fall-through', async () => {
    // The guard that makes this suite survive the NEXT status: iterate the shared
    // vocabulary rather than a list copied into the test.
    for (const status of COMPAT_GAP_STATUSES) {
      const patch = status === 'legacy_unassured'
        ? { schema_version: 'runtime-compat-gap-1.0', overall: { status, drift_class: 'none', release_notes_required: false } }
        : { overall: { status, drift_class: 'none', release_notes_required: false, assurance: { status: 'covered' }, assurance_state: 'readable' } };
      const out = await runWithGap(patch);
      ok(out.latest.status !== 'unrecognized', `${status} fell through to unrecognized`);
    }
  });

  it('a legacy 1.0 gap is legacy_unassured, and does NOT keep claiming current', async () => {
    // The hazard measured on the 34 real artifacts: today they all read
    // `current`, which under an assurance-keyed consumer is retroactive coverage.
    const out = await runWithGap({
      schema_version: 'runtime-compat-gap-1.0',
      overall: { status: 'current', drift_class: 'none', release_notes_required: false },
    }, { snapshotSchema: 'runtime-compat-snapshot-1.0' });
    strictEqual(out.latest.status, 'legacy_unassured');
    strictEqual(out.status, 'needs_attention');
    strictEqual(out.malformed, 0, 'history is readable — it must never be counted malformed');
  });

  it('an unknown family blocks instead of being consumed as its stored status', async () => {
    const out = await runWithGap({ schema_version: 'runtime-compat-gap-9.9' });
    strictEqual(out.latest.status, 'unrecognized');
    strictEqual(out.status, 'blocked');
    strictEqual(out.malformed, 0, 'a well-formed file this runtime cannot read is not a malformed one');
  });

  it('a plan artifact cannot mask an integrity block or legacy history', async () => {
    const root = await mkdtemp(join(tmpdir(), 'compat-readers-plan-'));
    const dir = join(root, '.agentic-plugins/runs/compat', RUN_ID);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'snapshot.json'), JSON.stringify({
      schema_version: COMPAT_SNAPSHOT_SCHEMA, run_id: RUN_ID,
      created_at: '2026-08-18T00:00:00Z', updated_at: '2026-08-18T00:00:00Z', hosts: {},
    }));
    await writeFile(join(dir, 'gap-analysis.json'), JSON.stringify({
      schema_version: COMPAT_GAP_SCHEMA, run_id: RUN_ID,
      overall: { status: 'assurance_blocked', drift_class: 'none', release_notes_required: false, assurance: { status: 'blocked' }, assurance_state: 'unreadable' },
      host_gaps: [], next_steps: ['stored repair step'],
    }));
    await writeFile(join(dir, 'plan.json'), JSON.stringify({
      schema_version: 'runtime-compat-plan-1.1', run_id: RUN_ID, status: 'planned', actionable: true,
      recommended_sequence: [{ step: 'refresh-baseline' }],
    }));
    const out = await inspectCompatRuns({ repoRoot: root });
    strictEqual(out.latest.status, 'assurance_blocked', 'a plan must not outrank an integrity failure');
    deepStrictEqual(out.latest.next_steps, ['stored repair step']);
  });
});
