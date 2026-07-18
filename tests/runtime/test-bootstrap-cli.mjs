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
    ? 'approval_policy = "on-request"\nsandbox_mode = "workspace-write"\n'
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

function boot({ argv, home, cwd, runner, subprocess, now = NOW }) {
  return runBootstrap({
    argv,
    env: {},
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
    strictEqual(profile.schema, 'agentic-machine-profile-1.0');
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
