// tests/runtime/test-bootstrap-cli.mjs
//
// machine-bootstrap-contract.md §11.2 — the PUBLIC-SURFACE half of the test
// obligations, driven through `runBootstrap` with every dependency injected
// (probe runner, subprocess runner, home, cwd, clock, hostname). The storage
// layer's obligations (#16/#28/#29/#30/#32 at the library seam) live in
// tests/runtime/test-bootstrap.mjs; this file exercises the §3 grammar, the
// R0/M1 boundary, the no-executor rule, and the CLI lifecycle end to end.

import { deepStrictEqual, ok, strictEqual } from 'node:assert';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  ANSWER_VALUES,
  EXIT,
  STAGE0_COMMANDS,
  parseBootstrapArgs,
  runBootstrap,
} from '../../plugins/runtime/scripts/bootstrap.mjs';
import { makeValidator } from '../../plugins/runtime/scripts/lib/schema-validate.mjs';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const PLUGIN_ROOT = join(REPO_ROOT, 'plugins', 'runtime');
const NOW = Date.parse('2026-07-18T04:00:00Z');

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

async function makeHome({ satisfied = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'bootstrap-cli-'));
  const home = join(root, 'home');
  const cwd = join(root, 'repo');
  await mkdir(home, { recursive: true });
  await mkdir(cwd, { recursive: true });
  // Host-config sentinels for #8 — byte-identity is asserted over these.
  await mkdir(join(home, '.claude'), { recursive: true });
  await mkdir(join(home, '.codex'), { recursive: true });
  await mkdir(join(home, '.agentic-plugins'), { recursive: true });
  await writeFile(join(home, '.claude', 'settings.json'), satisfied
    ? `${JSON.stringify({ permissions: { defaultMode: 'acceptEdits', allow: ['Read'] } }, null, 2)}\n`
    : '{}\n');
  await writeFile(join(home, '.codex', 'config.toml'), satisfied
    // notify wiring included: the ADR-0048 §1 split's notify.codex.configured
    // judge requires a parseable NON-EMPTY argv, so a "satisfied" fixture
    // carries one.
    ? 'approval_policy = "on-request"\nsandbox_mode = "workspace-write"\nnotify = ["node", "/tmp/receiver.mjs"]\n'
    : '# empty\n');
  await writeFile(join(home, '.agentic-plugins', 'config.local.toml'), '# local sentinel\n');
  if (satisfied) {
    await writeFile(join(home, '.agentic-plugins', 'config.toml'), 'model = "gpt-5.2-codex"\neffort = "high"\nnotify_channel = "file-log"\n');
  }
  return { root, home, cwd };
}

const HOST_CONFIG_SENTINELS = ['.claude/settings.json', '.codex/config.toml', '.agentic-plugins/config.local.toml'];

async function snapshotSentinels(home) {
  const out = {};
  for (const rel of HOST_CONFIG_SENTINELS) out[rel] = await readFile(join(home, rel), 'utf8');
  return out;
}

async function digestTree(dir) {
  const hash = createHash('sha256');
  const walk = async (path) => {
    let entries;
    try {
      entries = await readdir(path, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) {
        await walk(child);
      } else if (entry.isFile()) {
        hash.update(child.slice(dir.length));
        hash.update(await readFile(child));
      }
    }
  };
  await walk(dir);
  return hash.digest('hex');
}

const missing = () => ({ ok: false, exit_code: null, error_code: 'ENOENT', stdout: '', stderr: '' });
const okOut = (stdout) => ({ ok: true, exit_code: 0, error_code: null, stdout, stderr: '' });

const ALL_PLUGINS = ['runtime', 'companions', 'attention', 'engineer', 'orchestrator', 'founder', 'designer', 'image'];
// The Claude list parser expects the CLI's marker-prefixed rows (`❯ name@…`);
// a bare `name@…` row would lose its first character to the marker slot.
const claudePluginList = (names) => names
  .map((name) => `❯ ${name}@agentic-plugins\n  Version: 9.9.9\n  Status: enabled`)
  .join('\n');
const codexPluginList = (names) => JSON.stringify({
  installed: names.map((name) => ({ name, marketplaceName: 'agentic-plugins', installed: true, enabled: true, version: '9.9.9' })),
});
const MARKETPLACE_JSON = JSON.stringify([
  { name: 'agentic-plugins', source: 'github', repo: 'each4all/agentic-plugins', installLocation: '/nonexistent/marketplace-cache' },
]);

// A machine where nothing is installed: both CLIs absent.
function bareRunner() {
  return async () => missing();
}

// A machine where both hosts are present, authenticated, and registered, with
// `installed` naming the plugins present on both hosts.
function hostedRunner({ installed = ALL_PLUGINS } = {}) {
  return async (name, args) => {
    const key = `${name} ${args.join(' ')}`;
    if (key === 'claude --version') return okOut('2.1.0 (Claude Code)');
    if (key === 'claude auth status') return okOut(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' }));
    if (key === 'claude plugin list') return okOut(claudePluginList(installed));
    if (key === 'claude plugin marketplace list --json') return okOut(MARKETPLACE_JSON);
    if (name === 'claude') return okOut('usage');
    if (key === 'codex --version') return okOut('codex-cli 0.140.0');
    if (key === 'codex login status') return okOut('Logged in using ChatGPT');
    if (key === 'codex plugin list --json') return okOut(codexPluginList(installed));
    if (key === 'codex plugin marketplace list --json') return okOut(MARKETPLACE_JSON);
    if (name === 'codex') return okOut('usage');
    return missing();
  };
}

const satisfiedRunner = () => hostedRunner();

// The one declinable Stage-5 step this fixture never satisfies from config:
// egress is opt-in (ADR-0041 §3a default OFF), so the contract-shaped way to
// resolve it in a fixture is an explicit operator decline through --answers.
async function writeEgressDecline(home) {
  const path = join(home, 'egress-decline.json');
  await writeFile(path, JSON.stringify([{ step_id: 'egress.configured', answer: 'decline' }]));
  return path;
}

function spySubprocess({ settingsHash = null } = {}) {
  const calls = [];
  const runner = async (scriptPath, args) => {
    calls.push({ scriptPath, args: [...args] });
    if (scriptPath.endsWith('settings.mjs')) {
      return okOut(JSON.stringify({ plugin_management: { plan_hash: settingsHash } }));
    }
    return missing();
  };
  return { calls, runner };
}

function boot({ argv, home, cwd, runner, subprocess, now = NOW, env = {} }) {
  return runBootstrap({
    argv,
    env,
    homeDir: home,
    cwd,
    hostname: 'test-machine',
    now,
    runner,
    subprocessRunner: subprocess,
    pluginRoot: PLUGIN_ROOT,
  });
}

// ---------------------------------------------------------------------------
// §3 grammar (#34 and friends)
// ---------------------------------------------------------------------------

describe('runtime bootstrap CLI — §3 grammar', () => {
  it('#34 — --answers is refused on every non-interview verb with exit 40', async () => {
    for (const argv of [
      ['status', '--answers', '/dev/null'],
      ['verify', '--answers', '/dev/null'],
      ['abandon', '--latest-open', '--answers', '/dev/null'],
      ['profile', 'export', '--answers', '/dev/null'],
      ['profile', 'seed', '--profile-file', '/dev/null', '--answers', '/dev/null'],
    ]) {
      const { home, cwd } = await makeHome();
      const result = await boot({ argv, home, cwd, runner: bareRunner(), subprocess: spySubprocess().runner });
      strictEqual(result.exitCode, EXIT.INVALID, `${argv.join(' ')} must exit 40`);
      ok(/interview verbs/.test(result.report.error), 'the diagnostic teaches the §3 rule');
    }
  });

  it('run selectors are mutually exclusive; custom requires --plugins; --out does not exist', () => {
    for (const argv of [
      ['status', '--run-id', 'x', '--latest'],
      ['status', '--latest', '--latest-open'],
      ['plan', '--bundle', 'custom'],
      ['plan', '--plugins', 'runtime,companions'],
      ['profile', 'export', '--out', 'x'],
      ['abandon'],
      ['profile', 'seed'],
      ['nonsense'],
    ]) {
      let threw = null;
      try {
        parseBootstrapArgs(argv);
      } catch (err) {
        threw = err;
      }
      ok(threw, `${argv.join(' ')} must be rejected`);
      strictEqual(threw.exitCode, EXIT.INVALID);
    }
  });

  it('#12 — an illegal decline (never-declinable step) exits 40, an unexpected step_id exits 40', async () => {
    const { home, cwd } = await makeHome();
    const answersDir = join(home, 'answers');
    await mkdir(answersDir, { recursive: true });
    const illegal = join(answersDir, 'illegal.json');
    await writeFile(illegal, JSON.stringify([{ step_id: 'host.claude.present', answer: 'decline' }]));
    const one = await boot({ argv: ['plan', '--bundle', 'base', '--answers', illegal], home, cwd, runner: bareRunner(), subprocess: spySubprocess().runner });
    strictEqual(one.exitCode, EXIT.INVALID);
    ok(/not declinable/.test(one.report.error));

    const stale = join(answersDir, 'stale.json');
    await writeFile(stale, JSON.stringify([{ step_id: 'plugin.designer.claude.installed', answer: 'decline' }]));
    const two = await boot({ argv: ['plan', '--bundle', 'base', '--answers', stale], home, cwd, runner: bareRunner(), subprocess: spySubprocess().runner });
    strictEqual(two.exitCode, EXIT.INVALID, 'a step outside the base selection is not an expected step');
    ok(/not an expected step/.test(two.report.error));
    void ANSWER_VALUES;
  });
});

// ---------------------------------------------------------------------------
// Seam + consumer-repo (#1 static half, #2)
// ---------------------------------------------------------------------------

describe('runtime bootstrap CLI — machine seam (#1, #2)', () => {
  it('#1 — bootstrap.mjs never imports the repo-scoped doctor readers (static seam)', async () => {
    const source = await readFile(join(PLUGIN_ROOT, 'scripts', 'bootstrap.mjs'), 'utf8');
    for (const banned of ['inspectCatalogs', 'inspectSourcePluginState', "from './doctor.mjs'", "from './lib/state-readers.mjs'", 'runDoctor']) {
      ok(!source.includes(banned), `bootstrap.mjs must not reference ${banned} — the §1.1 seam is a separate library, not a filtered report`);
    }
  });

  it('#2 — from a consumer repo with a poisoned catalog, no output references the source-tree remediation paths', async () => {
    const { home, cwd } = await makeHome();
    // Poisoned catalog: if any code path read the invoking repository's
    // catalogs, this content would visibly leak into the report.
    await mkdir(join(cwd, '.claude-plugin'), { recursive: true });
    await writeFile(join(cwd, '.claude-plugin', 'marketplace.json'), JSON.stringify({ name: 'POISONED-CATALOG-DO-NOT-READ', plugins: [{ name: 'POISONED', source: './plugins/POISONED' }] }));
    const result = await boot({ argv: ['plan', '--bundle', 'base', '--format', 'json'], home, cwd, runner: bareRunner(), subprocess: spySubprocess().runner });
    strictEqual(result.exitCode, EXIT.INCOMPLETE);
    const text = result.rendered;
    for (const banned in { 'POISONED-CATALOG-DO-NOT-READ': 1, '.claude-plugin/marketplace.json': 1, '.agents/plugins/marketplace.json': 1, './plugins/': 1 }) {
      ok(!text.includes(banned), `plan output must not reference ${banned}`);
    }
  });

  it('Stage 0 — a bare machine gets the exact §2 commands for BOTH hosts', async () => {
    const { home, cwd } = await makeHome();
    const result = await boot({ argv: ['plan', '--bundle', 'base', '--format', 'json'], home, cwd, runner: bareRunner(), subprocess: spySubprocess().runner });
    strictEqual(result.exitCode, EXIT.INCOMPLETE, 'a machine missing a host reduces to incomplete (§8.3), never configured-not-verified');
    for (const host of ['claude', 'codex']) {
      deepStrictEqual(result.report.stage0[host].commands, [...STAGE0_COMMANDS[host]]);
    }
  });
});

// ---------------------------------------------------------------------------
// R0 / no-executor / plan-hash (#33, #9, #25 presentation half, #8)
// ---------------------------------------------------------------------------

describe('runtime bootstrap CLI — R0 and executor boundaries', () => {
  it('#33 — status and verify leave the ENTIRE artifact home byte-identical and never invoke doctor', async () => {
    const { home, cwd } = await makeHome({ satisfied: true });
    const spy = spySubprocess({ settingsHash: 'a'.repeat(64) });
    const answers = await writeEgressDecline(home);
    const plan = await boot({ argv: ['plan', '--bundle', 'base', '--answers', answers], home, cwd, runner: satisfiedRunner(), subprocess: spy.runner });
    strictEqual(plan.exitCode, EXIT.CONFIGURED_NOT_VERIFIED, 'CONFIG resolved + no proof recorded reduces to configured-not-verified (test #14 half)');

    const before = await digestTree(join(home, '.agentic-plugins'));
    const callsBefore = spy.calls.length;
    const status = await boot({ argv: ['status', '--latest'], home, cwd, runner: satisfiedRunner(), subprocess: spy.runner });
    const verify = await boot({ argv: ['verify', '--latest'], home, cwd, runner: satisfiedRunner(), subprocess: spy.runner });
    const after = await digestTree(join(home, '.agentic-plugins'));

    strictEqual(after, before, 'R0: the recursive digest of ~/.agentic-plugins must not move');
    strictEqual(spy.calls.length, callsBefore, 'R0: neither verb may spawn ANY subprocess — verify never manufactures a proof via doctor --record');
    strictEqual(status.exitCode, EXIT.CONFIGURED_NOT_VERIFIED);
    strictEqual(verify.exitCode, EXIT.CONFIGURED_NOT_VERIFIED, 'verify reports the absent required proof and exits 10 (§3)');
    const smoke = verify.report.completion.proofs.find((proof) => proof.kind === 'deep-peer-smoke');
    strictEqual(smoke.status, 'absent', 'the required proof is reported absent, never synthesized');
  });

  it('#9 + #25 — plan presents the settings executor with the plan hash and never passes an --execute-* flag itself', async () => {
    const { home, cwd } = await makeHome();
    const hash = 'f'.repeat(64);
    const spy = spySubprocess({ settingsHash: hash });
    // Hosts present + registered, but attention is missing on both — so the
    // plan carries real install candidates and must fetch + present the hash.
    const runner = hostedRunner({ installed: ALL_PLUGINS.filter((name) => name !== 'attention') });
    const result = await boot({ argv: ['plan', '--bundle', 'base', '--format', 'json'], home, cwd, runner, subprocess: spy.runner });
    strictEqual(result.exitCode, EXIT.INCOMPLETE);
    ok(result.report.plugin_management.actions.some((action) => action.plugin === 'attention'), 'the missing plugin produces an install candidate');
    // Presentation half of #25: the presented command carries the hash the
    // executor will revalidate (the refusal half lives with runtime:settings).
    ok(result.report.plugin_management.presented_command.includes(`--expected-plan-hash ${hash}`));
    for (const call of spy.calls) {
      ok(!call.args.some((arg) => String(arg).startsWith('--execute')), '#9: bootstrap may only run DRY-RUN subprocesses — no executor flag, ever');
      ok(!call.args.includes('--apply'), '#9: bootstrap never passes --apply either');
    }
    ok(spy.calls.every((call) => !call.scriptPath.endsWith('doctor.mjs')), 'plan never reaches for doctor');
  });

  it('#8 — plan + profile seed + verify leave every host-config sentinel byte-identical', async () => {
    const { home, cwd } = await makeHome({ satisfied: true });
    const spy = spySubprocess({ settingsHash: 'b'.repeat(64) });
    const sentinelsBefore = await snapshotSentinels(home);
    const answers = await writeEgressDecline(home);

    const plan = await boot({ argv: ['plan', '--bundle', 'base', '--answers', answers], home, cwd, runner: satisfiedRunner(), subprocess: spy.runner });
    strictEqual(plan.exitCode, EXIT.CONFIGURED_NOT_VERIFIED);
    const exported = await boot({ argv: ['profile', 'export', '--name', 'roundtrip'], home, cwd, runner: satisfiedRunner(), subprocess: spy.runner });
    strictEqual(exported.exitCode, EXIT.OK);
    const seeded = await boot({ argv: ['profile', 'seed', '--profile-file', join(home, '.agentic-plugins', 'profiles', 'roundtrip.json')], home, cwd, runner: satisfiedRunner(), subprocess: spy.runner });
    strictEqual(seeded.exitCode, EXIT.OK);
    const verify = await boot({ argv: ['verify', '--latest'], home, cwd, runner: satisfiedRunner(), subprocess: spy.runner });
    strictEqual(verify.exitCode, EXIT.CONFIGURED_NOT_VERIFIED);

    deepStrictEqual(await snapshotSentinels(home), sentinelsBefore, '#8: ~/.claude/settings.json, ~/.codex/config.toml, and config.local.toml must be byte-identical');
  });
});

// ---------------------------------------------------------------------------
// Lifecycle, concurrency, abandonment, profiles (#4, #29, #30, path security)
// ---------------------------------------------------------------------------

describe('runtime bootstrap CLI — lifecycle', () => {
  it('plan → status → resume → verify → abandon → plan runs the full loop with contract exit codes', async () => {
    const { home, cwd } = await makeHome();
    const spy = spySubprocess();
    const run = (argv) => boot({ argv, home, cwd, runner: bareRunner(), subprocess: spy.runner });

    strictEqual((await run(['plan', '--bundle', 'base'])).exitCode, EXIT.INCOMPLETE);
    strictEqual((await run(['status'])).exitCode, EXIT.INCOMPLETE);
    const resume = await run(['resume', '--latest-open']);
    strictEqual(resume.exitCode, EXIT.INCOMPLETE, 'resume without execute answers re-probes and persists, still incomplete');
    strictEqual((await run(['verify', '--latest'])).exitCode, EXIT.INCOMPLETE);

    // #10.2 concurrency: a second plan is rejected NAMING the open run.
    const second = await run(['plan', '--bundle', 'base']);
    strictEqual(second.exitCode, EXIT.INVALID);
    ok(second.report.open_runs.length === 1 && /^bootstrap-/.test(second.report.open_runs[0]));

    // #29 CLI half: the open run closes via abandon and a new plan succeeds.
    strictEqual((await run(['abandon', '--latest-open', '--reason', 'test'])).exitCode, EXIT.OK);
    strictEqual((await run(['plan', '--bundle', 'base'])).exitCode, EXIT.INCOMPLETE);
    strictEqual((await run(['abandon', '--latest-open'])).exitCode, EXIT.OK);
  });

  // ADR-0048 §3 read-back — the false-demotion regression. Before 1.2 the
  // proof/ files were write-only: re-judgement consumed the manifest's REDUCED
  // completion.proofs (a shape with no `directions`), so recomputeProofStatus
  // read every direction as `absent` and a once-passed proof demoted to
  // `absent` on the SECOND verify. The recorded evidence is now read back and
  // re-judged, so `passed` survives every subsequent status/verify/resume.
  it('a passed proof stays passed across repeated verify/resume — recorded evidence is read back, never the reduced cache', async () => {
    const { home, cwd } = await makeHome({ satisfied: true });
    const doctorStub = async (scriptPath, args) => {
      if (scriptPath.endsWith('settings.mjs')) return okOut(JSON.stringify({ plugin_management: { plan_hash: null } }));
      if (scriptPath.endsWith('doctor.mjs')) {
        if (args.includes('--execute-deep-peer-smoke')) {
          return okOut(JSON.stringify({
            deep_peer_smoke: {
              directions: {
                claude_to_codex: { execution: 'executed', status: 'passed' },
                codex_to_claude: { execution: 'executed', status: 'passed' },
              },
            },
            doctor_artifact: { artifact_pointer: '~/.agentic-plugins/runs/doctor/stub/artifact.json' },
          }));
        }
        // The hook-attestation fetch path: no codex_hook_review → resume warns and moves on.
        return okOut(JSON.stringify({}));
      }
      return missing();
    };
    const run = (argv) => boot({ argv, home, cwd, runner: hostedRunner(), subprocess: doctorStub });

    const plan = await run(['plan', '--bundle', 'base', '--format', 'json']);
    const runId = plan.report.run_id;

    const answersPath = join(home, 'execute-smoke.json');
    await writeFile(answersPath, JSON.stringify([{ step_id: 'proof.deep-peer-smoke', answer: 'execute' }]));
    const resume = await run(['resume', '--latest-open', '--answers', answersPath]);
    const proofAfterResume = resume.report.completion.proofs.find((p) => p.kind === 'deep-peer-smoke');
    strictEqual(proofAfterResume?.status, 'passed', `the executed smoke reduces to passed: ${JSON.stringify(proofAfterResume?.reasons)}`);

    // The RECORDED evidence keeps its per-direction results on disk.
    const recorded = JSON.parse(await readFile(join(home, '.agentic-plugins', 'runs', 'bootstrap', runId, 'proof', 'deep-peer-smoke.json'), 'utf8'));
    strictEqual(recorded.directions['claude->codex'].status, 'passed');

    // First AND second verify: still passed. The second one is the regression —
    // it used to demote to `absent` because the reduced cache had no directions.
    for (const round of [1, 2]) {
      const verify = await run(['verify', '--run-id', runId]);
      const proof = verify.report.completion.proofs.find((p) => p.kind === 'deep-peer-smoke');
      strictEqual(proof?.status, 'passed', `verify round ${round} keeps the recorded pass (got ${proof?.status}: ${JSON.stringify(proof?.reasons)})`);
    }
    const status = await run(['status', '--run-id', runId]);
    strictEqual(status.report.completion.proofs.find((p) => p.kind === 'deep-peer-smoke')?.status, 'passed', 'status reads the same recorded evidence');
  });

  it('fragment persistence COMPOSES the actionable egress recovery with the §10.3 guidance instead of replacing it (Codex review)', async () => {
    const { home, cwd } = await makeHome();
    const plan = await boot({ argv: ['plan', '--bundle', 'base', '--format', 'json'], home, cwd, runner: bareRunner(), subprocess: spySubprocess().runner });
    const manifest = JSON.parse(await readFile(join(home, '.agentic-plugins', 'runs', 'bootstrap', plan.report.run_id, 'run.json'), 'utf8'));
    const egress = manifest.steps.find((step) => step.id === 'egress.configured');
    strictEqual(egress.status, 'pending');
    ok(egress.fragment_pointer, 'the egress launcher fragment was persisted for the pending step');
    // Both halves must survive: the activation procedure (channel+recipient+
    // credential, placeholder-only) AND the fragment backup/verify guidance.
    ok(/ADR-0041 §2c/.test(egress.recovery), 'the actionable activation recovery survives fragment persistence');
    ok(/TELEGRAM_BOT_TOKEN/.test(egress.recovery), 'the credential env-key procedure survives fragment persistence');
    ok(/Backup /.test(egress.recovery), 'the §10.3 fragment guidance is appended');
  });

  it('the persisted run manifest validates against the packaged §5 schema', async () => {
    const { home, cwd } = await makeHome();
    const spy = spySubprocess();
    const plan = await boot({ argv: ['plan', '--bundle', 'engineering', '--format', 'json'], home, cwd, runner: bareRunner(), subprocess: spy.runner });
    strictEqual(plan.exitCode, EXIT.INCOMPLETE);
    const manifest = JSON.parse(await readFile(join(home, '.agentic-plugins', 'runs', 'bootstrap', plan.report.run_id, 'run.json'), 'utf8'));
    const validate = await makeValidator('runtime-bootstrap-run', { pluginRoot: PLUGIN_ROOT });
    const verdict = validate(manifest);
    deepStrictEqual(verdict.errors, [], 'the run manifest must validate against runtime-bootstrap-run');
    ok(verdict.ok);
    // §6.1 registry sanity on the persisted copy: explicit blocked_by arrays.
    ok(manifest.steps.every((step) => Array.isArray(step.blocked_by)), 'an empty blocked_by is written explicitly, never omitted');
  });

  it('#4 + #30 — profile export → seed round-trips (id + hash recorded); overwrite is refused without --overwrite; path traversal is refused', async () => {
    const { home, cwd } = await makeHome({ satisfied: true });
    const spy = spySubprocess();
    const run = (argv) => boot({ argv, home, cwd, runner: satisfiedRunner(), subprocess: spy.runner });

    const exported = await run(['profile', 'export', '--name', 'machine-a']);
    strictEqual(exported.exitCode, EXIT.OK);
    const profilePath = join(home, '.agentic-plugins', 'profiles', 'machine-a.json');
    const profile = JSON.parse(await readFile(profilePath, 'utf8'));
    strictEqual(profile.schema, 'agentic-machine-profile-1.1');
    ok(Object.values(profile.boundary).every((flag) => flag === false), 'every boundary flag is false');

    // #30 — refuse without --overwrite, succeed with it.
    strictEqual((await run(['profile', 'export', '--name', 'machine-a'])).exitCode, EXIT.INVALID);
    strictEqual((await run(['profile', 'export', '--name', 'machine-a', '--overwrite'])).exitCode, EXIT.OK);

    // Path security at the CLI: a traversal-shaped --name is invalid input.
    let traversal;
    try {
      traversal = await run(['profile', 'export', '--name', '../escape']);
    } catch (err) {
      traversal = { exitCode: EXIT.INVALID, threw: err };
    }
    strictEqual(traversal.exitCode ?? EXIT.INVALID, EXIT.INVALID, 'a traversal --name never writes');

    // #4 — seed records the profile id + hash on the open run.
    const answers = await writeEgressDecline(home);
    strictEqual((await run(['plan', '--bundle', 'base', '--answers', answers])).exitCode, EXIT.CONFIGURED_NOT_VERIFIED);
    const seeded = await run(['profile', 'seed', '--profile-file', profilePath]);
    strictEqual(seeded.exitCode, EXIT.OK);
    strictEqual(seeded.report.seeded_from.profile_id, 'machine-a');
    ok(/^[0-9a-f]{64}$/.test(seeded.report.seeded_from.profile_hash));
    const manifest = JSON.parse(await readFile(join(home, '.agentic-plugins', 'runs', 'bootstrap', seeded.report.run_id, 'run.json'), 'utf8'));
    deepStrictEqual(manifest.seeded_from, seeded.report.seeded_from, 'the run manifest carries the seeded_from linkage');
    ok(Array.isArray(seeded.report.proposals.proposals), 'seed presents proposals as defaults requiring confirmation');
    ok(seeded.report.proposals.proposals.every((proposal) => proposal.requires_confirmation === true && proposal.applied === false));

    strictEqual((await run(['abandon', '--latest-open'])).exitCode, EXIT.OK);
  });

  it('with no run at all, status / resume / verify / seed answer no-active-run with exit 30', async () => {
    const { home, cwd } = await makeHome();
    const spy = spySubprocess();
    for (const argv of [['status'], ['resume'], ['verify'], ['profile', 'seed', '--profile-file', join(home, 'missing.json')]]) {
      const result = await boot({ argv, home, cwd, runner: bareRunner(), subprocess: spy.runner });
      if (argv[1] === 'seed') {
        // seed validates the profile file first; a missing file is invalid
        // input (40) rather than a run-selection miss.
        ok([EXIT.NO_ACTIVE_RUN, EXIT.INVALID].includes(result.exitCode), `${argv.join(' ')} exits 30 or 40`);
      } else {
        strictEqual(result.exitCode, EXIT.NO_ACTIVE_RUN, `${argv.join(' ')} exits 30`);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// ADR-0048 §3 / D0.1 — the attest verb (owner phone-receipt testimony)
// ---------------------------------------------------------------------------

describe('runtime bootstrap CLI — attest (ADR-0048 §3 / D0.1)', () => {
  const EGRESS_ENV = Object.freeze({
    AGENTIC_NOTIFY_EGRESS_CHANNEL: 'telegram',
    TELEGRAM_CHAT_ID: '123456789',
    TELEGRAM_BOT_TOKEN: 'test-secret-token-value',
  });

  it('refuses an open run (resume is the audited door), a terminal run with no ack, and an abandoned run outright', async () => {
    const { home, cwd } = await makeHome({ satisfied: true });
    const spy = spySubprocess();
    const run = (argv) => boot({ argv, home, cwd, runner: hostedRunner(), subprocess: spy.runner, env: { ...EGRESS_ENV } });

    const plan = await run(['plan', '--bundle', 'base', '--format', 'json']);
    const runId = plan.report.run_id;

    // Open → the audited resume --answers path is the only door (D0.1).
    const onOpen = await run(['attest', '--run-id', runId]);
    strictEqual(onOpen.exitCode, EXIT.INVALID);
    ok(/resume --answers/.test(onOpen.report.diagnostics.join(' ')), 'the refusal routes to the audited path');

    // Terminal (current-schema) with no recorded ack → the missing-evidence refusal.
    const bareId = 'bootstrap-20260718T040000Z-0bb001';
    const dir = join(home, '.agentic-plugins', 'runs', 'bootstrap', bareId);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'run.json'), `${JSON.stringify({
      schema: 'runtime-bootstrap-run-1.2',
      run_id: bareId,
      started_at: '2026-07-18T04:00:00Z',
      updated_at: '2026-07-18T04:00:00Z',
      status: 'configured-not-verified',
      selection: { bundle: 'base', desired: ['runtime', 'companions'], excluded: [] },
      steps: [],
      boundary: { writes_host_config: false, writes_credential: false, writes_config_local_toml: false, performs_network_request: false },
    }, null, 2)}\n`);
    const noAck = await run(['attest', '--run-id', bareId]);
    strictEqual(noAck.exitCode, EXIT.INVALID);
    ok(/pre-existing acked attempt/.test(noAck.report.diagnostics.join(' ')), 'the refusal names the missing ack');

    await run(['abandon', '--run-id', runId, '--reason', 'test']);
    const onAbandoned = await run(['attest', '--run-id', runId]);
    strictEqual(onAbandoned.exitCode, EXIT.INVALID);
    ok(/abandoned run is an escape hatch/.test(onAbandoned.report.diagnostics.join(' ')));
  });

  it('refuses a legacy-schema run — attest records 1.2 evidence only', async () => {
    const { home, cwd } = await makeHome({ satisfied: true });
    const spy = spySubprocess();
    // Seed a schema-1.1 terminal run directly (the pre-vnext world).
    const runId = 'bootstrap-20260716T000000Z-abcdef';
    const dir = join(home, '.agentic-plugins', 'runs', 'bootstrap', runId);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'run.json'), `${JSON.stringify({
      schema: 'runtime-bootstrap-run-1.1',
      run_id: runId,
      started_at: '2026-07-16T00:00:00Z',
      updated_at: '2026-07-16T00:00:00Z',
      status: 'complete',
      selection: { bundle: 'base', desired: [], excluded: [] },
      steps: [],
      boundary: { writes_host_config: false, writes_credential: false, writes_config_local_toml: false, performs_network_request: false },
    }, null, 2)}\n`);

    const result = await boot({ argv: ['attest', '--run-id', runId], home, cwd, runner: hostedRunner(), subprocess: spy.runner, env: { ...EGRESS_ENV } });
    strictEqual(result.exitCode, EXIT.INVALID);
    ok(/schema runtime-bootstrap-run-1\.1/.test(result.report.diagnostics.join(' ')), 'the refusal names the legacy schema');
  });

  it('records testimony over a currently-passing ack, and the completion renders delivery-attested', async () => {
    const { home, cwd } = await makeHome({ satisfied: true });
    const spy = spySubprocess();
    const env = { ...EGRESS_ENV };
    const run = (argv) => boot({ argv, home, cwd, runner: hostedRunner(), subprocess: spy.runner, env });

    // 1. Plan with the egress-proof opt-in (an execute answer makes the step expected).
    const optIn = join(home, 'opt-in.json');
    await writeFile(optIn, JSON.stringify([{ step_id: 'proof.egress-provider-ack', answer: 'execute' }]));
    const plan = await run(['plan', '--bundle', 'base', '--answers', optIn, '--format', 'json']);
    const runId = plan.report.run_id;
    ok(plan.report.steps.some((s) => s.id === 'proof.egress-provider-ack'), 'the opt-in makes the step expected');

    // 2. Seed the ack proof the executor leaf will eventually produce: bound to
    //    the CURRENT hosted probe and the CURRENT activation fingerprint.
    const { deriveActivationFingerprint } = await import('../../plugins/runtime/scripts/lib/evidence-contract.mjs');
    const { writeBootstrapProof } = await import('../../plugins/runtime/scripts/lib/bootstrap-artifacts.mjs');
    const { RUNTIME_VERSION } = await import('../../plugins/runtime/scripts/version.mjs');
    const { loadPluginSet, resolveBundle } = await import('../../plugins/runtime/scripts/lib/plugin-set.mjs');
    const pluginSet = await loadPluginSet({ pluginRoot: PLUGIN_ROOT });
    const base = resolveBundle(pluginSet, 'base');
    const perHost = (host) => Object.fromEntries(base.filter((n) => (pluginSet.plugins[n]?.hosts ?? []).includes(host)).map((n) => [n, '9.9.9']));
    const fingerprint = deriveActivationFingerprint({ channel: 'telegram', recipient: EGRESS_ENV.TELEGRAM_CHAT_ID, credentialEnvVar: 'TELEGRAM_BOT_TOKEN' });
    const attempt = 'a'.repeat(64);
    const seeded = await writeBootstrapProof({
      homeDir: home,
      repoRoot: null,
      runId,
      kind: 'egress-provider-ack',
      record: {
        kind: 'egress-provider-ack',
        status: 'passed',
        provider_ack: { result: 'acked', attempt_hash: attempt, activation_fingerprint: fingerprint, ran_at: new Date(NOW).toISOString() },
        artifact_pointer: null,
        artifact_hash: null,
        bound_versions: { runtime: RUNTIME_VERSION, claude: '2.1.0', codex: '0.140.0', plugins: { claude: perHost('claude'), codex: perHost('codex') } },
        ran_at: new Date(NOW).toISOString(),
      },
    });
    strictEqual(seeded.ok, true, `ack seed persists: ${seeded.diagnostics.join('; ')}`);

    // 3. Execute the smoke through the doctor stub so the run TERMINALIZES as
    //    complete (attest is the post-terminal door only — an open run routes
    //    through resume --answers).
    const exec = join(home, 'execute-smoke.json');
    await writeFile(exec, JSON.stringify([{ step_id: 'proof.deep-peer-smoke', answer: 'execute' }]));
    const doctorStub = async (scriptPath, args) => {
      if (scriptPath.endsWith('settings.mjs')) return okOut(JSON.stringify({ plugin_management: { plan_hash: null } }));
      if (scriptPath.endsWith('doctor.mjs')) {
        if (args.includes('--execute-deep-peer-smoke')) {
          return okOut(JSON.stringify({
            deep_peer_smoke: { directions: { claude_to_codex: { execution: 'executed', status: 'passed' }, codex_to_claude: { execution: 'executed', status: 'passed' } } },
            doctor_artifact: { artifact_pointer: '~/.agentic-plugins/runs/doctor/stub/artifact.json' },
          }));
        }
        return okOut(JSON.stringify({}));
      }
      return missing();
    };
    const resume = await boot({ argv: ['resume', '--run-id', runId, '--answers', exec, '--format', 'json'], home, cwd, runner: hostedRunner(), subprocess: doctorStub, env });
    strictEqual(resume.report.run_status, 'complete', `the run terminalizes complete over the executed smoke + recorded ack: ${JSON.stringify(resume.report.completion.proofs?.filter((p) => p.required).map((p) => [p.kind, p.status, p.reasons]))} unsat=${JSON.stringify(resume.report.completion.unsatisfied)} warn=${JSON.stringify(resume.report.warnings)}`);

    // 4. Attest the terminal run: testimony lands, verdict attested, label derives.
    const attest = await run(['attest', '--run-id', runId, '--format', 'json']);
    strictEqual(attest.exitCode, EXIT.OK, JSON.stringify(attest.report.diagnostics ?? attest.report));
    strictEqual(attest.report.receipt.status, 'attested', JSON.stringify(attest.report.receipt));
    strictEqual(attest.report.receipt.attempt_hash, attempt);

    // 5. A REPEATED attest over the same attempt/bytes is idempotent — the
    //    original testimony (its attested_at included) survives verbatim.
    const receiptPath = join(home, '.agentic-plugins', 'runs', 'bootstrap', runId, 'proof', 'egress-receipt-attestation.json');
    const firstBytes = await readFile(receiptPath, 'utf8');
    const again = await boot({ argv: ['attest', '--run-id', runId, '--format', 'json'], home, cwd, runner: hostedRunner(), subprocess: spy.runner, env, now: NOW + 60_000 });
    strictEqual(again.exitCode, EXIT.OK);
    strictEqual(await readFile(receiptPath, 'utf8'), firstBytes, 'identical testimony is never rewritten');

    const verify = await run(['verify', '--run-id', runId]);
    ok(/delivery-attested/.test(verify.rendered), 'the derived label decorates the completion line');
    ok(/receipt attestation: attested/.test(verify.rendered), 'the receipt line is rendered');
  });
});

// ---------------------------------------------------------------------------
// ADR-0048 §1 — open/terminal run migration across schema minors
// ---------------------------------------------------------------------------

describe('runtime bootstrap CLI — schema-minor migration (ADR-0048 §1)', () => {
  const legacyOpenManifest = (runId) => ({
    schema: 'runtime-bootstrap-run-1.1',
    run_id: runId,
    started_at: '2026-07-16T00:00:00Z',
    updated_at: '2026-07-16T00:00:00Z',
    status: 'open',
    selection: { bundle: 'base', desired: ['runtime', 'companions', 'attention'], excluded: [] },
    steps: [],
    boundary: { writes_host_config: false, writes_credential: false, writes_config_local_toml: false, performs_network_request: false },
  });

  async function seedManifest(home, manifest) {
    const dir = join(home, '.agentic-plugins', 'runs', 'bootstrap', manifest.run_id);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'run.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    return dir;
  }

  it('an OPEN legacy run migrates additively on resume: schema stamped, history row, new steps injected, fragments rendered', async () => {
    const { home, cwd } = await makeHome({ satisfied: true });
    const runId = 'bootstrap-20260716T000000Z-0aa001';
    await seedManifest(home, legacyOpenManifest(runId));

    const resume = await boot({ argv: ['resume', '--run-id', runId, '--format', 'json'], home, cwd, runner: hostedRunner(), subprocess: spySubprocess().runner });
    ok(resume.exitCode !== EXIT.INVALID, JSON.stringify(resume.report.diagnostics ?? []));

    const migrated = JSON.parse(await readFile(join(home, '.agentic-plugins', 'runs', 'bootstrap', runId, 'run.json'), 'utf8'));
    strictEqual(migrated.schema, 'runtime-bootstrap-run-1.2', 'the schema stamp is bumped explicitly (the old spread preserved 1.1)');
    ok(migrated.history.some((h) => h.from === 'runtime-bootstrap-run-1.1' && h.to === 'runtime-bootstrap-run-1.2'), 'the migration is a history row, not a silent rewrite');
    // Registry-new steps joined the persisted run (the 1.1 world had no notify.codex.configured).
    ok(migrated.steps.some((s) => s.id === 'notify.codex.configured'), 'the ADR-0048 §1 split step was injected additively');
    // The satisfied fixture wires notify=, so the injected step judged satisfied on the same resume.
    strictEqual(migrated.steps.find((s) => s.id === 'notify.codex.configured').status, 'satisfied');
  });

  it('a TERMINAL legacy run is immutable history: exit 50, historical markers, stored completion verbatim, no re-certification', async () => {
    const { home, cwd } = await makeHome({ satisfied: true });
    const runId = 'bootstrap-20260716T000000Z-0aa002';
    const stored = {
      ...legacyOpenManifest(runId),
      status: 'complete',
      completion: { state: 'complete', unsatisfied: [], missing_steps: [], proofs: [], hook_attestation: { status: 'not-applicable', reasons: [], attested_plugins: [], bound_versions: null, artifact_pointer: null, artifact_hash: null, attested_at: null } },
    };
    await seedManifest(home, stored);
    const before = await readFile(join(home, '.agentic-plugins', 'runs', 'bootstrap', runId, 'run.json'), 'utf8');

    for (const verb of ['status', 'verify']) {
      const result = await boot({ argv: [verb, '--run-id', runId, '--format', 'json'], home, cwd, runner: hostedRunner(), subprocess: spySubprocess().runner });
      strictEqual(result.exitCode, EXIT.LEGACY_HISTORICAL, `${verb} exits 50, never a current-completion code`);
      strictEqual(result.report.historical, true);
      strictEqual(result.report.not_recertified, true);
      deepStrictEqual(result.report.completion, stored.completion, `${verb} presents the stored completion verbatim`);
    }
    const text = await boot({ argv: ['status', '--run-id', runId], home, cwd, runner: hostedRunner(), subprocess: spySubprocess().runner });
    ok(/HISTORICAL/.test(text.rendered), 'the text render carries the historical marker');
    const after = await readFile(join(home, '.agentic-plugins', 'runs', 'bootstrap', runId, 'run.json'), 'utf8');
    strictEqual(after, before, 'the terminal record is byte-identical — nothing re-certified or rewritten');
  });

  it('a FUTURE-minor run refuses the M1 resume — this runtime must not persist a document it half-understands', async () => {
    const { home, cwd } = await makeHome({ satisfied: true });
    const runId = 'bootstrap-20260716T000000Z-0aa003';
    await seedManifest(home, { ...legacyOpenManifest(runId), schema: 'runtime-bootstrap-run-1.9' });

    const resume = await boot({ argv: ['resume', '--run-id', runId], home, cwd, runner: hostedRunner(), subprocess: spySubprocess().runner });
    strictEqual(resume.exitCode, EXIT.INVALID);
    ok(/newer than this runtime/.test(resume.report.diagnostics.join(' ')), 'the refusal names the version relation');
  });
});

function renderOf(result) {
  return result.rendered ?? '';
}
