// tests/runtime/test-bootstrap-cli.mjs
//
// machine-bootstrap-contract.md §11.2 — the PUBLIC-SURFACE half of the test
// obligations, driven through `runBootstrap` with every dependency injected
// (probe runner, subprocess runner, home, cwd, clock, hostname). The storage
// layer's obligations (#16/#28/#29/#30/#32 at the library seam) live in
// tests/runtime/test-bootstrap.mjs; this file exercises the §3 grammar, the
// R0/M1 boundary, the no-executor rule, and the CLI lifecycle end to end.

import { deepStrictEqual, ok, rejects, strictEqual } from 'node:assert';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  ANSWER_VALUES,
  EXIT,
  STAGE0_COMMANDS,
  parseBootstrapArgs,
  renderText,
  runBootstrap,
} from '../../plugins/runtime/scripts/bootstrap.mjs';
import { makeValidator } from '../../plugins/runtime/scripts/lib/schema-validate.mjs';
import { deriveActivationFingerprint } from '../../plugins/runtime/scripts/lib/evidence-contract.mjs';

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
    // statusLine included: the statusline.claude.configured judge is an EXACT
    // probe — satisfied means the settings command EQUALS this home's
    // canonical shim invocation.
    ? `${JSON.stringify({ permissions: { defaultMode: 'acceptEdits', allow: ['Read'] }, statusLine: { type: 'command', command: `node '${join(home, '.agentic-plugins', 'bin', 'agentic-statusline.mjs').replace(/\\/g, '/')}'` } }, null, 2)}\n`
    : '{}\n');
  await writeFile(join(home, '.codex', 'config.toml'), satisfied
    // notify wiring + the canonical agentic-6 status_line included: both
    // Codex-side exact probes must observe their canonical configuration in a
    // "satisfied" fixture (notify-axis + statusline slices).
    ? `approval_policy = "on-request"\nsandbox_mode = "workspace-write"\nnotify = ["/usr/bin/env", "node", "${join(home, '.agentic-plugins', 'bin', 'codex-notify-shuttle.mjs')}"]\n[tui]\nstatus_line = ["model-with-reasoning", "git-branch", "pull-request-number", "context-used", "five-hour-limit", "weekly-limit"]\n`
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
      // attest records receipt testimony WITHOUT an answers file (the
      // attest-receipt ANSWER is resume-only; the attest VERB is the
      // post-terminal door) — so it is a non-interview verb here too.
      ['attest', '--answers', '/dev/null'],
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

  // ADR-0048 §3/D0.2 — the egress proof is OPT-IN, and "opted in" must not be
  // satisfied by the plan that enumerated the step. The registry pushes
  // `proof.egress-provider-ack` on every run so it can be reported, `judgeSteps`
  // persists that row as `not-applicable`, and both readers used to test only
  // that the row EXISTED — so every machine owed a proof it never asked for and
  // could never reach `complete`. `status`/`verify`/`resume` all re-derive the
  // opt-in through reprobeAgainstRun with no answers file, so they are the sites
  // that regress: assert across the whole loop, not just at plan.
  it('a run planned with NO answers never owes the egress proof — across plan, status, resume and verify', async () => {
    const { home, cwd } = await makeHome();
    const spy = spySubprocess();
    const run = (argv) => boot({ argv, home, cwd, runner: bareRunner(), subprocess: spy.runner });
    const egressOf = (report) => report.completion.proofs.find((p) => p.kind === 'egress-provider-ack');

    const plan = await run(['plan', '--bundle', 'base', '--format', 'json']);
    // Fixture sanity: the row IS enumerated. Without this the assertions below
    // would hold for the wrong reason — a run that simply lacked the step.
    const row = plan.report.steps.find((s) => s.id === 'proof.egress-provider-ack');
    ok(row, 'the step is enumerated even unrequested (§6.1 — reported, not owed)');
    strictEqual(row.status, 'not-applicable');

    for (const [label, argv] of [
      ['plan', null],
      ['status', ['status', '--format', 'json']],
      ['resume', ['resume', '--latest-open', '--format', 'json']],
      ['verify', ['verify', '--latest', '--format', 'json']],
    ]) {
      const report = argv === null ? plan.report : (await run(argv)).report;
      const egress = egressOf(report);
      strictEqual(egress.required, false, `${label} must not owe an unrequested egress proof`);
      strictEqual(egress.status, 'not-applicable', `${label} judges it not-applicable, never absent`);
    }
    strictEqual((await run(['abandon', '--latest-open'])).exitCode, EXIT.OK);
  });

  it('an opt-in answer DOES make it owed — the same loop, the other direction', async () => {
    const { home, cwd } = await makeHome();
    const spy = spySubprocess();
    const run = (argv) => boot({ argv, home, cwd, runner: bareRunner(), subprocess: spy.runner });
    const optIn = join(home, 'egress-opt-in.json');
    await writeFile(optIn, JSON.stringify([{ step_id: 'proof.egress-provider-ack', answer: 'execute' }]));

    const plan = await run(['plan', '--bundle', 'base', '--answers', optIn, '--format', 'json']);
    const planned = plan.report.completion.proofs.find((p) => p.kind === 'egress-provider-ack');
    strictEqual(planned.required, true, 'the recorded answer is the opt-in');

    // The opt-in must SURVIVE a verb that passes no answers file — it persists on
    // the run's own step row and in choices[], not in the invocation.
    const status = await run(['status', '--format', 'json']);
    const later = status.report.completion.proofs.find((p) => p.kind === 'egress-provider-ack');
    strictEqual(later.required, true, 'status re-derives the opt-in from the run, not from argv');
    strictEqual((await run(['abandon', '--latest-open'])).exitCode, EXIT.OK);
  });

  // The `choices[]` leg IN ISOLATION. `judgeSteps` rewrites the egress row on
  // every re-judgement, so the row cannot be the ledger's backstop: on a run whose
  // row was written by the judge, only the recorded answer distinguishes an opt-in
  // from the enumeration. Forcing the row to `not-applicable` while keeping the
  // choice is the one edit that isolates this leg — and it is also the shape a
  // run poisoned by the old presence test would have if it HAD answered.
  it('the choices ledger alone keeps the proof owed — a hand-cleared step row does not release it', async () => {
    const { home, cwd } = await makeHome();
    const spy = spySubprocess();
    const run = (argv) => boot({ argv, home, cwd, runner: bareRunner(), subprocess: spy.runner });
    const optIn = join(home, 'egress-opt-in.json');
    await writeFile(optIn, JSON.stringify([{ step_id: 'proof.egress-provider-ack', answer: 'execute' }]));

    const plan = await run(['plan', '--bundle', 'base', '--answers', optIn, '--format', 'json']);
    const runPath = join(home, '.agentic-plugins', 'runs', 'bootstrap', plan.report.run_id, 'run.json');
    const manifest = JSON.parse(await readFile(runPath, 'utf8'));
    ok(manifest.choices.some((c) => c.step_id === 'proof.egress-provider-ack'), 'the answer ledger recorded it');
    // `blocked`, not `pending`: this fixture never configures egress, so the
    // demotion pass blocks the proof behind `egress.configured`.
    strictEqual(
      manifest.steps.find((s) => s.id === 'proof.egress-provider-ack').status,
      'blocked',
      'ground truth for this fixture — the judge blocks the opted-in proof behind egress.configured',
    );

    await writeFile(runPath, JSON.stringify({
      ...manifest,
      steps: manifest.steps.map((s) => (s.id === 'proof.egress-provider-ack' ? { ...s, status: 'not-applicable' } : s)),
    }, null, 2));

    const status = await run(['status', '--format', 'json']);
    const egress = status.report.completion.proofs.find((p) => p.kind === 'egress-provider-ack');
    strictEqual(egress.required, true, 'the recorded answer still owes the proof');
    strictEqual(egress.status, 'absent', 'and it is absent, not not-applicable — the run still owes evidence');

    // The persisted ROW must agree with that verdict. The reducer derives the
    // requirement independently, so a re-probe that failed to carry the opt-in into
    // its expected set would leave the manifest self-contradicting: a row reading
    // `not-applicable` beside a completion saying the proof is owed.
    await run(['resume', '--latest-open', '--format', 'json']);
    const rejudged = JSON.parse(await readFile(runPath, 'utf8'));
    const rejudgedRow = rejudged.steps.find((s) => s.id === 'proof.egress-provider-ack');
    ok(rejudgedRow.status !== 'not-applicable',
      `the re-probe carries the opt-in into the row too (got ${rejudgedRow.status})`);
    strictEqual((await run(['abandon', '--latest-open'])).exitCode, EXIT.OK);
  });

  // The opt-in arriving at RESUME time rather than plan time. At that invocation
  // the run's stored ledger does NOT yet hold the answer — it is appended by the
  // same update that persists the judged rows — so a reduction over the stored
  // ledger alone would report the proof the operator just authorized as
  // not-applicable, and a machine could terminalize without ever owing it.
  it('an opt-in answered at resume time is owed in the SAME invocation', async () => {
    const { home, cwd } = await makeHome();
    const spy = spySubprocess();
    const run = (argv) => boot({ argv, home, cwd, runner: bareRunner(), subprocess: spy.runner });

    const plan = await run(['plan', '--bundle', 'base', '--format', 'json']);
    const planned = plan.report.completion.proofs.find((p) => p.kind === 'egress-provider-ack');
    strictEqual(planned.required, false, 'nothing owed before the answer');

    const optIn = join(home, 'egress-opt-in.json');
    await writeFile(optIn, JSON.stringify([{ step_id: 'proof.egress-provider-ack', answer: 'execute' }]));
    const resume = await run(['resume', '--latest-open', '--answers', optIn, '--format', 'json']);
    const owed = resume.report.completion.proofs.find((p) => p.kind === 'egress-provider-ack');
    strictEqual(owed.required, true, 'the answer counts in the invocation that made it, not only the next one');

    // And it persists, so the following read-only verb agrees.
    const status = await run(['status', '--format', 'json']);
    strictEqual(status.report.completion.proofs.find((p) => p.kind === 'egress-provider-ack').required, true);
    strictEqual((await run(['abandon', '--latest-open'])).exitCode, EXIT.OK);
  });

  // The poisoning case the row-status leg would have created. A run planned under
  // the broken presence test and then resumed by it holds a judge-written
  // `pending`/`blocked` egress row with NO answer behind it; version invalidation
  // preserves both statuses and a same-schema run never enters the migration path.
  // Had the fix accepted generic row status as consent, that run would owe an
  // impossible proof forever — the original defect, surviving its own fix.
  it('a run POISONED by the old presence test heals — a judge-written row with no answer stops owing the proof', async () => {
    const { home, cwd } = await makeHome();
    const spy = spySubprocess();
    const run = (argv) => boot({ argv, home, cwd, runner: bareRunner(), subprocess: spy.runner });

    const plan = await run(['plan', '--bundle', 'base', '--format', 'json']);
    const runPath = join(home, '.agentic-plugins', 'runs', 'bootstrap', plan.report.run_id, 'run.json');
    const manifest = JSON.parse(await readFile(runPath, 'utf8'));
    ok(!manifest.choices.some((c) => c.step_id === 'proof.egress-provider-ack'), 'nobody answered');

    // Exactly what an old-code resume persisted: the row promoted, ledger untouched.
    for (const poisoned of ['pending', 'blocked']) {
      await writeFile(runPath, JSON.stringify({
        ...manifest,
        steps: manifest.steps.map((s) => (s.id === 'proof.egress-provider-ack' ? { ...s, status: poisoned } : s)),
      }, null, 2));

      const status = await run(['status', '--format', 'json']);
      const egress = status.report.completion.proofs.find((p) => p.kind === 'egress-provider-ack');
      strictEqual(egress.required, false, `a '${poisoned}' row with no answer must not owe the proof`);
      strictEqual(egress.status, 'not-applicable');
    }

    // And the heal is persisted, not just reported: resume re-judges the row back
    // to not-applicable, so the poison does not linger in the file.
    await run(['resume', '--latest-open', '--format', 'json']);
    const healed = JSON.parse(await readFile(runPath, 'utf8'));
    strictEqual(
      healed.steps.find((s) => s.id === 'proof.egress-provider-ack').status,
      'not-applicable',
      'the next judgement rewrites the poisoned row',
    );
    strictEqual((await run(['abandon', '--latest-open'])).exitCode, EXIT.OK);
  });

  // The proof file is written BEFORE the manifest update that records the choice
  // and the promoted row, so a failure in between (a validation refusal, a full
  // disk, a kill) leaves real delivery evidence on disk beside a manifest that
  // still says nobody opted in. Without the evidence leg, `recomputeProofStatus`
  // short-circuits to `not-applicable` and never inspects the record: a FAILED ack
  // would be reduced away and the run could read `complete`. Simulated here by
  // writing the proof and then reverting the manifest to its pre-answer bytes —
  // the exact state that window produces.
  it('a recorded ack survives a manifest that never recorded the choice — evidence is judged, not reduced away', async () => {
    const { home, cwd } = await makeHome();
    const spy = spySubprocess();
    const run = (argv) => boot({ argv, home, cwd, runner: bareRunner(), subprocess: spy.runner });

    const plan = await run(['plan', '--bundle', 'base', '--format', 'json']);
    const runId = plan.report.run_id;
    const runPath = join(home, '.agentic-plugins', 'runs', 'bootstrap', runId, 'run.json');
    const preAnswer = await readFile(runPath, 'utf8');

    const { writeBootstrapProof } = await import('../../plugins/runtime/scripts/lib/bootstrap-artifacts.mjs');
    const persisted = await writeBootstrapProof({
      homeDir: home,
      repoRoot: null,
      runId,
      kind: 'egress-provider-ack',
      record: {
        kind: 'egress-provider-ack',
        status: 'failed',
        provider_ack: { result: 'failed', attempt_hash: 'a'.repeat(64), activation_fingerprint: 'f'.repeat(64), ran_at: new Date(NOW).toISOString() },
        mirror_correlated: false,
        artifact_pointer: null,
        artifact_hash: 'b'.repeat(64),
        // Any well-formed binding: the point is that the record gets JUDGED at all.
        // On this bare fixture it re-judges failed/stale either way — what must never
        // happen is the not-applicable short-circuit that skips the record entirely.
        bound_versions: { runtime: '0.0.1', claude: '0.0.1', codex: '0.0.1', plugins: { claude: {}, codex: {} } },
        ran_at: new Date(NOW).toISOString(),
      },
    });
    ok(persisted?.ok, `proof write failed: ${JSON.stringify(persisted)}`);
    // The manifest update that would have recorded choice + row never landed.
    await writeFile(runPath, preAnswer);
    const reverted = JSON.parse(preAnswer);
    ok(!reverted.choices.some((c) => c.step_id === 'proof.egress-provider-ack'), 'no choice was recorded');
    strictEqual(reverted.steps.find((s) => s.id === 'proof.egress-provider-ack').status, 'not-applicable');

    const status = await run(['status', '--format', 'json']);
    const egress = status.report.completion.proofs.find((p) => p.kind === 'egress-provider-ack');
    strictEqual(egress.required, true, 'evidence on disk makes the run accountable for it');
    ok(egress.status !== 'not-applicable', `the record is judged, not skipped (got ${egress.status})`);
    ok(status.report.completion.state !== 'complete', 'a machine holding a failed ack never reads complete');

    // Row/completion agreement, as for the other two provenances: the re-probe
    // must carry recorded evidence into its expected set too, or the manifest is
    // left claiming not-applicable about a proof the completion says is owed.
    await run(['resume', '--latest-open', '--format', 'json']);
    const rejudged = JSON.parse(await readFile(runPath, 'utf8'));
    const rejudgedRow = rejudged.steps.find((s) => s.id === 'proof.egress-provider-ack');
    ok(rejudgedRow.status !== 'not-applicable',
      `the re-probe carries recorded evidence into the row too (got ${rejudgedRow.status})`);
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
        // Not the hook-attestation path: this fixture plans `base`, whose
        // selection has no Codex hook-bearing plugin, so §8.2 never runs. The
        // import itself is covered in the §8.2 block at the end of this file.
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
        // The fully-verified shape: the reducer's recomputed aggregate
        // requires the mirror seat AND a linkable artifact hash alongside
        // the ack (a seed missing either reduces failed, and attest would
        // rightly refuse the testimony).
        mirror_correlated: true,
        artifact_pointer: null,
        artifact_hash: 'b'.repeat(64),
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

    // 6. At-rest evidence downgrade (Refine-verify round 3): if the persisted
    //    ack record loses its mirror leg AFTER terminalization, the recomputed
    //    aggregate goes failed and a FRESH attest refuses the testimony — the
    //    gate consumes the recomputation, never the stored status. (The
    //    receipt from step 4 already exists; delete it so the refusal below
    //    is the ack gate, not receipt idempotency.)
    const ackPath = join(home, '.agentic-plugins', 'runs', 'bootstrap', runId, 'proof', 'egress-provider-ack.json');
    const ackRecord = JSON.parse(await readFile(ackPath, 'utf8'));
    ackRecord.mirror_correlated = false;
    await writeFile(ackPath, `${JSON.stringify(ackRecord, null, 2)}\n`);
    await rm(receiptPath);
    const refused = await run(['attest', '--run-id', runId, '--format', 'json']);
    strictEqual(refused.exitCode, EXIT.INVALID, JSON.stringify(refused.report));
    ok((refused.report.diagnostics ?? []).some((d) => /pass/i.test(d) || /ack/i.test(d)),
      `the refusal names the non-passing ack: ${JSON.stringify(refused.report.diagnostics)}`);

    // 7. Same downgrade through the ARTIFACT-HASH leg (Refine-verify round
    //    4): restore the mirror but drop the doctor-artifact hash — the
    //    three-leg recompute fails on linkage and a fresh attest refuses.
    ackRecord.mirror_correlated = true;
    ackRecord.artifact_hash = null;
    await writeFile(ackPath, `${JSON.stringify(ackRecord, null, 2)}\n`);
    const refusedNoHash = await run(['attest', '--run-id', runId, '--format', 'json']);
    strictEqual(refusedNoHash.exitCode, EXIT.INVALID, JSON.stringify(refusedNoHash.report));
  });
});

// ---------------------------------------------------------------------------
// ADR-0048 §2.1 — frozen [tui] preview vs a re-rendered combined fragment
// ---------------------------------------------------------------------------

describe('bootstrap [tui] one-source invariant — frozen re-transition is NAMED (Refine-verify round 3)', () => {
  it('a satisfied→pending statusline re-transition WITHOUT version drift keeps the frozen preview and warns, naming the combined fragment as the source', async () => {
    // Hosted runner: versions are observed and stable across plan → resume,
    // so §7 invalidation never fires and the notify artifact stays FROZEN
    // with the preview it rendered while the statusline step was satisfied.
    // When the statusline observation then disappears, resume re-renders the
    // combined fragment beside the frozen preview — two [tui] carriers. The
    // reconciliation is the fragment-freeze follow-up; the run must NAME the
    // supersession instead of hiding it.
    const { home, cwd } = await makeHome();
    const codexConfig = join(home, '.codex', 'config.toml');
    await writeFile(codexConfig, '[tui]\nstatus_line = ["model-with-reasoning", "git-branch", "pull-request-number", "context-used", "five-hour-limit", "weekly-limit"]\n');
    const run = (argv) => boot({ argv, home, cwd, runner: hostedRunner(), subprocess: spySubprocess().runner });

    const plan = await run(['plan', '--bundle', 'base', '--format', 'json']);
    const runId = plan.report.run_id;
    strictEqual(plan.report.steps.find((s) => s.id === 'statusline.codex.configured').status, 'satisfied');
    const fragmentsDir = join(home, '.agentic-plugins', 'runs', 'bootstrap', runId, 'fragments');
    const notifyBefore = JSON.parse(await readFile(join(fragmentsDir, 'notification-plan.fragment'), 'utf8'));
    ok(notifyBefore.fragments.tui_notifications_toml, 'the preview is the carrier while the statusline step is satisfied');

    // The observation disappears (operator reverted their config) — same
    // versions, so the freeze holds.
    await writeFile(codexConfig, '# empty\n');
    const resume = await run(['resume', '--run-id', runId, '--format', 'json']);

    const carriers = [];
    for (const name of (await readdir(fragmentsDir)).filter((n) => n.endsWith('.fragment')).sort()) {
      if (/\[tui\]/.test(await readFile(join(fragmentsDir, name), 'utf8'))) carriers.push(name);
    }
    deepStrictEqual(carriers, ['notification-plan.fragment', 'statusline-codex.fragment'],
      'the frozen preview and the re-rendered combined fragment coexist — the honest state the warning exists for');
    ok((resume.report.warnings ?? []).some((w) => /frozen notification-plan artifact still carries/.test(w) && /combined statusline-codex fragment/.test(w)),
      `the two-carrier state is NAMED with the superseding source: ${JSON.stringify(resume.report.warnings)}`);
  });

  it('a DECLINED statusline step never makes its historical combined fragment authoritative — the fresh preview stays the presented source (round-4 High)', async () => {
    // Plan with notify satisfied + statusline pending: the combined fragment
    // renders carrying BOTH keys and the (satisfied) notify step persists no
    // artifact. Then notify regresses to pending while the operator DECLINES
    // statusline: the declined step keeps its historical pointer, but that
    // frozen fragment still carries the refused status_line key — routing
    // the operator there would make a refused key authoritative. The strip
    // predicate must treat a dead step's pointer as history: the fresh
    // notification preview is the presented [tui] source, un-stripped and
    // un-noted.
    const { home, cwd } = await makeHome({ satisfied: true });
    const codexConfig = join(home, '.codex', 'config.toml');
    const notifyOnly = `approval_policy = "on-request"\nsandbox_mode = "workspace-write"\nnotify = ["/usr/bin/env", "node", "${join(home, '.agentic-plugins', 'bin', 'codex-notify-shuttle.mjs')}"]\n`;
    await writeFile(codexConfig, notifyOnly);
    const run = (argv) => boot({ argv, home, cwd, runner: hostedRunner(), subprocess: spySubprocess().runner });

    const plan = await run(['plan', '--bundle', 'base', '--format', 'json']);
    const runId = plan.report.run_id;
    strictEqual(plan.report.steps.find((s) => s.id === 'notify.codex.configured').status, 'satisfied');
    ok(plan.report.steps.find((s) => s.id === 'statusline.codex.configured').fragment_pointer,
      'the combined fragment rendered while the statusline step was alive');
    const fragmentsDir = join(home, '.agentic-plugins', 'runs', 'bootstrap', runId, 'fragments');

    // notify regresses (wiring removed) + the operator declines statusline.
    await writeFile(codexConfig, '# empty\n');
    const answersPath = join(home, 'decline-sl.json');
    await writeFile(answersPath, JSON.stringify([{ step_id: 'statusline.codex.configured', answer: 'decline' }]));
    const resume = await run(['resume', '--run-id', runId, '--answers', answersPath, '--format', 'json']);
    strictEqual(resume.report.steps.find((s) => s.id === 'statusline.codex.configured').status, 'declined');

    const notifyArtifact = JSON.parse(await readFile(join(fragmentsDir, 'notification-plan.fragment'), 'utf8'));
    ok(notifyArtifact.fragments.tui_notifications_toml,
      'the fresh preview is the presented source — a declined step\'s historical fragment must not swallow it');
    ok(notifyArtifact.tui_note == null,
      'no routing note may point at a declined (historical) combined fragment');
    ok(!(resume.report.warnings ?? []).some((w) => /frozen notification-plan artifact/.test(w)),
      `no supersession warning — the preview IS the source here: ${JSON.stringify(resume.report.warnings)}`);
  });

  it('the frozen-supersession warning inspects the preview FIELD, not the serialized text — a [tui] literal in tui_warning is not a preview (round-4 false-positive)', async () => {
    const { home, cwd } = await makeHome();
    const codexConfig = join(home, '.codex', 'config.toml');
    await writeFile(codexConfig, '[tui]\nstatus_line = ["model-with-reasoning", "git-branch", "pull-request-number", "context-used", "five-hour-limit", "weekly-limit"]\n');
    const run = (argv) => boot({ argv, home, cwd, runner: hostedRunner(), subprocess: spySubprocess().runner });

    const plan = await run(['plan', '--bundle', 'base', '--format', 'json']);
    const runId = plan.report.run_id;
    const notifyPath = join(home, '.agentic-plugins', 'runs', 'bootstrap', runId, 'fragments', 'notification-plan.fragment');
    // Simulate a frozen artifact whose preview is ALREADY stripped but whose
    // builder-level prose legitimately contains the [tui] literal.
    const artifact = JSON.parse(await readFile(notifyPath, 'utf8'));
    artifact.fragments.tui_notifications_toml = null;
    artifact.tui_warning = 'existing [tui] notifications were observed in the host config';
    await writeFile(notifyPath, `${JSON.stringify(artifact, null, 2)}\n`);

    await writeFile(codexConfig, '# empty\n');
    const resume = await run(['resume', '--run-id', runId, '--format', 'json']);
    ok(!(resume.report.warnings ?? []).some((w) => /frozen notification-plan artifact still carries/.test(w)),
      `a stripped preview with prose-level [tui] must not trigger the supersession warning: ${JSON.stringify(resume.report.warnings)}`);
  });

  it('declining the statusline step on an all-pending run NAMES the no-source state and withdraws the declined hand-off (rounds 5-6)', async () => {
    // All-pending plan: the combined fragment renders and the notify
    // artifact persists STRIPPED. The operator then declines statusline:
    // decline withdraws the step's presentation fields (pointer + apply +
    // desired), the combined fragment loses authority, and the run now
    // presents NO [tui] source. Runtime must NAME that state with a
    // re-plan warning — never rewrite the frozen artifact (a round-5
    // restore attempt opened a fragment-vs-manifest commit-ordering hole;
    // round-6 High). The declined step's historical hand-off must not
    // render anywhere.
    const { home, cwd } = await makeHome();
    const run = (argv) => boot({ argv, home, cwd, runner: hostedRunner(), subprocess: spySubprocess().runner });

    const plan = await run(['plan', '--bundle', 'base', '--format', 'json']);
    const runId = plan.report.run_id;
    const fragmentsDir = join(home, '.agentic-plugins', 'runs', 'bootstrap', runId, 'fragments');
    const stripped = JSON.parse(await readFile(join(fragmentsDir, 'notification-plan.fragment'), 'utf8'));
    strictEqual(stripped.fragments.tui_notifications_toml, null, 'all-pending plan strips the preview (combined is the source)');
    const strippedBytes = await readFile(join(fragmentsDir, 'notification-plan.fragment'), 'utf8');

    const answersPath = join(home, 'decline-sl-allpending.json');
    await writeFile(answersPath, JSON.stringify([{ step_id: 'statusline.codex.configured', answer: 'decline' }]));
    const resume = await run(['resume', '--run-id', runId, '--answers', answersPath, '--format', 'json']);

    const slStep = resume.report.steps.find((s) => s.id === 'statusline.codex.configured');
    strictEqual(slStep.status, 'declined');
    strictEqual(slStep.fragment_pointer ?? null, null, 'decline withdraws the presentation pointer — a refused key is history');
    strictEqual(slStep.apply_command ?? null, null, 'decline withdraws the apply command');
    strictEqual(slStep.desired ?? null, null, 'decline withdraws the frozen plan expectation');

    strictEqual(await readFile(join(fragmentsDir, 'notification-plan.fragment'), 'utf8'), strippedBytes,
      'the frozen artifact is NEVER rewritten (no fragment-vs-manifest commit-ordering hole)');
    ok((resume.report.warnings ?? []).some((w) => /presents NO \[tui\] source/.test(w) && /Re-plan/.test(w)),
      `the no-source state is NAMED with the re-plan recovery: ${JSON.stringify(resume.report.warnings)}`);

    const rendered = (await run(['status', '--run-id', runId])).rendered;
    const renderedLines = rendered.split('\n');
    const declinedIdx = renderedLines.findIndex((l) => /statusline\.codex\.configured: declined/.test(l));
    ok(declinedIdx >= 0, 'the declined step still renders its status line');
    ok(!/^\s+(apply:|fragment:)/.test(renderedLines[declinedIdx + 1] ?? ''),
      `the declined step's historical hand-off must not render beneath it: next line = ${JSON.stringify(renderedLines[declinedIdx + 1])}`);
  });

  it('a LEGACY declined step later observed satisfied never resurrects its refused render state (round-6 Medium)', async () => {
    // Seed a run whose statusline step was declined by an OLDER runtime that
    // did not withdraw the fields, then make the observation satisfy it: the
    // observation legitimately wins (§6.2), but the refused pointer must not
    // ride along and fragment_applied must not promote off a refused render.
    const { home, cwd } = await makeHome();
    await writeFile(join(home, '.codex', 'config.toml'), '# empty\n');
    const run = (argv) => boot({ argv, home, cwd, runner: hostedRunner(), subprocess: spySubprocess().runner });
    const plan = await run(['plan', '--bundle', 'base', '--format', 'json']);
    const runId = plan.report.run_id;

    // Rewrite the manifest into the legacy shape: declined WITH fields.
    const runPath = join(home, '.agentic-plugins', 'runs', 'bootstrap', runId, 'run.json');
    const manifest = JSON.parse(await readFile(runPath, 'utf8'));
    const slStep = manifest.steps.find((s) => s.id === 'statusline.codex.configured');
    slStep.status = 'declined';
    slStep.fragment_pointer = '~/.agentic-plugins/runs/bootstrap/' + runId + '/fragments/statusline-codex.fragment';
    slStep.apply_command = 'Merge the rendered [tui] table (historical refused render)';
    slStep.desired = JSON.stringify(['model-with-reasoning']);
    await writeFile(runPath, `${JSON.stringify(manifest, null, 2)}\n`);

    // The observation now satisfies the step (operator configured it by hand).
    await writeFile(join(home, '.codex', 'config.toml'), '[tui]\nstatus_line = ["model-with-reasoning", "git-branch", "pull-request-number", "context-used", "five-hour-limit", "weekly-limit"]\n');
    const resume = await run(['resume', '--run-id', runId, '--format', 'json']);
    const judged = resume.report.steps.find((s) => s.id === 'statusline.codex.configured');
    strictEqual(judged.status, 'satisfied', 'the live observation wins over the recorded decline (§6.2)');
    strictEqual(judged.fragment_pointer ?? null, null, 'the refused pointer never resurrects');
    strictEqual(judged.apply_command ?? null, null, 'the refused apply command never resurrects');
    ok(judged.fragment_applied !== true,
      'a refused render is never promoted to fragment_applied — a satisfying observation over a decline is a manual/pre-existing match');
  });

  it('a LEGACY declined step with a pointer but NO frozen desired also never promotes fragment_applied (round-6 Medium, desired-free variant)', async () => {
    // Without a frozen `desired` the exact probe accepts any canonical form,
    // so the observation satisfies immediately — the only thing standing
    // between the refused pointer and a fragment_applied promotion is the
    // pre-judgement declined strip. This variant pins that path directly.
    const { home, cwd } = await makeHome();
    await writeFile(join(home, '.codex', 'config.toml'), '# empty\n');
    const run = (argv) => boot({ argv, home, cwd, runner: hostedRunner(), subprocess: spySubprocess().runner });
    const plan = await run(['plan', '--bundle', 'base', '--format', 'json']);
    const runId = plan.report.run_id;

    const runPath = join(home, '.agentic-plugins', 'runs', 'bootstrap', runId, 'run.json');
    const manifest = JSON.parse(await readFile(runPath, 'utf8'));
    const slStep = manifest.steps.find((s) => s.id === 'statusline.codex.configured');
    slStep.status = 'declined';
    slStep.fragment_pointer = '~/.agentic-plugins/runs/bootstrap/' + runId + '/fragments/statusline-codex.fragment';
    slStep.apply_command = 'Merge the rendered [tui] table (historical refused render)';
    slStep.desired = null;
    await writeFile(runPath, `${JSON.stringify(manifest, null, 2)}\n`);

    await writeFile(join(home, '.codex', 'config.toml'), '[tui]\nstatus_line = ["model-with-reasoning", "git-branch", "pull-request-number", "context-used", "five-hour-limit", "weekly-limit"]\n');
    const resume = await run(['resume', '--run-id', runId, '--format', 'json']);
    const judged = resume.report.steps.find((s) => s.id === 'statusline.codex.configured');
    strictEqual(judged.status, 'satisfied');
    strictEqual(judged.fragment_pointer ?? null, null, 'the refused pointer never resurrects (desired-free variant)');
    ok(judged.fragment_applied !== true, 'the refused render never promotes fragment_applied (desired-free variant)');
  });

  it('a frozen artifact that fails to PARSE keeps the supersession call conservative, never silent (round-5 Medium)', async () => {
    const { home, cwd } = await makeHome();
    const codexConfig = join(home, '.codex', 'config.toml');
    await writeFile(codexConfig, '[tui]\nstatus_line = ["model-with-reasoning", "git-branch", "pull-request-number", "context-used", "five-hour-limit", "weekly-limit"]\n');
    const run = (argv) => boot({ argv, home, cwd, runner: hostedRunner(), subprocess: spySubprocess().runner });

    const plan = await run(['plan', '--bundle', 'base', '--format', 'json']);
    const runId = plan.report.run_id;
    const notifyPath = join(home, '.agentic-plugins', 'runs', 'bootstrap', runId, 'fragments', 'notification-plan.fragment');
    // Truncate the frozen artifact mid-preview: unparseable, preview fate unknown.
    const original = await readFile(notifyPath, 'utf8');
    await writeFile(notifyPath, original.slice(0, Math.floor(original.length / 2)));

    await writeFile(codexConfig, '# empty\n');
    const resume = await run(['resume', '--run-id', runId, '--format', 'json']);
    ok((resume.report.warnings ?? []).some((w) => /could not be parsed/.test(w) && /combined statusline-codex fragment is the presented/.test(w)),
      `parse failure must warn conservatively, not silence the supersession: ${JSON.stringify(resume.report.warnings)}`);
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

// ---------------------------------------------------------------------------
// ADR-0048 §3 — egress-provider-ack via the doctor executor, end to end
// ---------------------------------------------------------------------------

describe('bootstrap egress-provider-ack executor E2E (ADR-0048 §3)', () => {
  const EGRESS_ENV = {
    AGENTIC_NOTIFY_EGRESS_CHANNEL: 'telegram',
    TELEGRAM_CHAT_ID: '424242424242',
    TELEGRAM_BOT_TOKEN: '999999:e2e-sentinel-token',
  };
  // The fingerprint the CURRENT readers derive from EGRESS_ENV — the stubbed
  // doctor report must echo it, or the reducer honestly re-judges the recorded
  // ack stale (recorded against an activation this machine no longer carries).
  const CURRENT_FINGERPRINT = deriveActivationFingerprint({
    channel: 'telegram',
    recipient: '424242424242',
    credentialEnvVar: 'TELEGRAM_BOT_TOKEN',
  });
  const ATTEMPT_HASH = 'a'.repeat(64);
  const ARTIFACT_SHA = 'b'.repeat(64);

  function egressDoctorStub({ blocked = false } = {}) {
    const calls = [];
    const runner = async (scriptPath, args) => {
      calls.push({ scriptPath, args: [...args] });
      if (scriptPath.endsWith('settings.mjs')) return okOut(JSON.stringify({ plugin_management: { plan_hash: null } }));
      if (scriptPath.endsWith('doctor.mjs')) {
        if (args.includes('--execute-egress-ack-proof')) {
          if (blocked) {
            return okOut(JSON.stringify({
              egress_ack_proof: {
                requested: true, executed: false, mode: 'explicit_egress_executor', status: 'blocked',
                provider_ack: null, outcome_reason: null, mirror_correlated: false, network_request_performed: false,
                blockers: ['AGENTIC_EGRESS_REAL_SMOKE=1 is not set — the real-network send needs this third consent alongside the two flags (export it in the shell that runs the executor)'],
                limits: [],
              },
              doctor_artifact: { artifact_pointer: '~/.agentic-plugins/runs/doctor/stub/doctor.json', artifact_sha256: ARTIFACT_SHA },
            }));
          }
          return okOut(JSON.stringify({
            egress_ack_proof: {
              requested: true, executed: true, mode: 'explicit_egress_executor', status: 'passed',
              provider_ack: { result: 'acked', attempt_hash: ATTEMPT_HASH, activation_fingerprint: CURRENT_FINGERPRINT, ran_at: '2026-07-18T04:00:00.000Z' },
              outcome_reason: 'dispatched', mirror_correlated: true, network_request_performed: true,
              subject_suffix: 'abcdef012345', blockers: [], limits: [],
            },
            doctor_artifact: { artifact_pointer: '~/.agentic-plugins/runs/doctor/stub/doctor.json', artifact_sha256: ARTIFACT_SHA },
          }));
        }
        // Not the hook-attestation path either — `base` again (see above).
        return okOut(JSON.stringify({}));
      }
      return missing();
    };
    return { calls, runner };
  }

  it('resume executes the opted-in egress proof through doctor, persists provider_ack evidence with the artifact hash, then attest-receipt completes delivery attestation', async () => {
    const { home, cwd } = await makeHome({ satisfied: true });
    const stub = egressDoctorStub();
    const run = (argv) => boot({ argv, home, cwd, runner: hostedRunner(), subprocess: stub.runner, env: EGRESS_ENV });

    const plan = await run(['plan', '--bundle', 'base', '--format', 'json']);
    const runId = plan.report.run_id;

    // Stage 8 — the operator's explicit `execute` answer against the opt-in step.
    const answersPath = join(home, 'execute-egress.json');
    await writeFile(answersPath, JSON.stringify([{ step_id: 'proof.egress-provider-ack', answer: 'execute' }]));
    const resume = await run(['resume', '--latest-open', '--answers', answersPath]);

    // The doctor invocation used the registered flag pair (both consents) + --record.
    const doctorCall = stub.calls.find((c) => c.scriptPath.endsWith('doctor.mjs') && c.args.includes('--execute-egress-ack-proof'));
    ok(doctorCall, 'resume must delegate to runtime:doctor for the egress proof');
    ok(doctorCall.args.includes('--egress-ack-proof'), 'the plan flag rides with the execute flag');
    ok(doctorCall.args.includes('--record'), 'the §8.2 delegation is a --record invocation');

    // The recorded proof: provider_ack (single-delivery evidence, NO directions)
    // + the doctor artifact linked by its exact-byte hash — for THIS kind and,
    // per the same slice, every kind (artifact_hash import for ALL kinds).
    const proofPath = join(home, '.agentic-plugins', 'runs', 'bootstrap', runId, 'proof', 'egress-provider-ack.json');
    const recorded = JSON.parse(await readFile(proofPath, 'utf8'));
    strictEqual(recorded.kind, 'egress-provider-ack');
    strictEqual(recorded.provider_ack.result, 'acked');
    strictEqual(recorded.provider_ack.attempt_hash, ATTEMPT_HASH);
    strictEqual(recorded.artifact_hash, ARTIFACT_SHA, 'the doctor artifact_sha256 is imported as artifact_hash');
    strictEqual(recorded.directions, undefined, 'egress evidence is single-delivery — no directions member');

    const ackAfterResume = resume.report.completion.proofs.find((p) => p.kind === 'egress-provider-ack');
    strictEqual(ackAfterResume?.status, 'passed', `the executed ack reduces to passed: ${JSON.stringify(ackAfterResume?.reasons)}`);
    strictEqual(resume.report.completion.egress_receipt_attestation?.status === 'attested', false, 'no receipt testimony yet');

    // D0.1 — the owner's after-the-fact phone-receipt testimony on a later resume.
    const attestPath = join(home, 'attest-egress.json');
    await writeFile(attestPath, JSON.stringify([{ step_id: 'proof.egress-provider-ack', answer: 'attest-receipt' }]));
    const attest = await run(['resume', '--latest-open', '--answers', attestPath]);

    const receiptPath = join(home, '.agentic-plugins', 'runs', 'bootstrap', runId, 'proof', 'egress-receipt-attestation.json');
    const receipt = JSON.parse(await readFile(receiptPath, 'utf8'));
    strictEqual(receipt.surface, 'owner-phone');
    strictEqual(receipt.attempt_hash, ATTEMPT_HASH, 'the testimony names the acked synthetic attempt');
    const ackBytes = await readFile(proofPath);
    strictEqual(receipt.provider_proof_artifact_hash, createHash('sha256').update(ackBytes).digest('hex'), 'the testimony links the stored ack bytes by hash');

    const verdict = attest.report.completion.egress_receipt_attestation;
    strictEqual(verdict?.status, 'attested', `delivery is attested: ${JSON.stringify(verdict)}`);
    const ackFinal = attest.report.completion.proofs.find((p) => p.kind === 'egress-provider-ack');
    strictEqual(ackFinal?.status, 'passed', 'the machine proof still stands beside the human testimony');
  });

  it('a blocked doctor executor surfaces its blockers as a resume warning, records nothing, and stays retryable', async () => {
    const { home, cwd } = await makeHome({ satisfied: true });
    const stub = egressDoctorStub({ blocked: true });
    const run = (argv) => boot({ argv, home, cwd, runner: hostedRunner(), subprocess: stub.runner, env: EGRESS_ENV });

    const plan = await run(['plan', '--bundle', 'base', '--format', 'json']);
    const runId = plan.report.run_id;
    const answersPath = join(home, 'execute-egress.json');
    await writeFile(answersPath, JSON.stringify([{ step_id: 'proof.egress-provider-ack', answer: 'execute' }]));
    const resume = await run(['resume', '--latest-open', '--answers', answersPath]);

    ok(resume.report.warnings.some((w) => /AGENTIC_EGRESS_REAL_SMOKE=1/.test(w)), `the third-consent blocker reaches the operator: ${JSON.stringify(resume.report.warnings)}`);
    let proofExists = true;
    try { await readFile(join(home, '.agentic-plugins', 'runs', 'bootstrap', runId, 'proof', 'egress-provider-ack.json')); } catch { proofExists = false; }
    strictEqual(proofExists, false, 'a blocked executor persists no proof record (the kind stays absent and retryable)');
    const ack = resume.report.completion.proofs.find((p) => p.kind === 'egress-provider-ack');
    ok(ack?.status !== 'passed', 'nothing reduces to passed off a blocked executor');
  });
});

// The two remaining executor-slice behaviors, each pinned by a test that its
// mutation demonstrably fails (mutation-verified guards, not decoration):
// the acked-consistency refusal and the post-execution READERS re-read.
describe('bootstrap egress-provider-ack executor — consistency matrix + readers re-read (ADR-0048 §3)', () => {
  const EGRESS_ENV_NO_RECIPIENT = {
    AGENTIC_NOTIFY_EGRESS_CHANNEL: 'telegram',
    TELEGRAM_BOT_TOKEN: '999999:e2e-sentinel-token',
  };

  it('an internally inconsistent doctor section (passed without a correlated mirror) is refused, not persisted', async () => {
    const { home, cwd } = await makeHome({ satisfied: true });
    const calls = [];
    const runner = async (scriptPath, args) => {
      calls.push({ scriptPath, args: [...args] });
      if (scriptPath.endsWith('settings.mjs')) return okOut(JSON.stringify({ plugin_management: { plan_hash: null } }));
      if (scriptPath.endsWith('doctor.mjs')) {
        if (args.includes('--execute-egress-ack-proof')) {
          return okOut(JSON.stringify({
            egress_ack_proof: {
              requested: true, executed: true, mode: 'explicit_egress_executor',
              // The forged shape the matrix exists to refuse: a pass whose own
              // evidence legs contradict it.
              status: 'passed',
              provider_ack: { result: 'acked', attempt_hash: 'a'.repeat(64), activation_fingerprint: 'c'.repeat(64), ran_at: '2026-07-18T04:00:00.000Z' },
              outcome_reason: 'dispatched', mirror_correlated: false, network_request_performed: true,
              subject_suffix: 'abcdef012345', blockers: [], limits: [],
            },
            doctor_artifact: { artifact_pointer: '~/.agentic-plugins/runs/doctor/stub/doctor.json', artifact_sha256: 'b'.repeat(64) },
          }));
        }
        return okOut(JSON.stringify({}));
      }
      return missing();
    };
    const env = { ...EGRESS_ENV_NO_RECIPIENT, TELEGRAM_CHAT_ID: '424242424242' };
    const run = (argv) => boot({ argv, home, cwd, runner: hostedRunner(), subprocess: runner, env });

    const plan = await run(['plan', '--bundle', 'base', '--format', 'json']);
    const runId = plan.report.run_id;
    const answersPath = join(home, 'execute-egress.json');
    await writeFile(answersPath, JSON.stringify([{ step_id: 'proof.egress-provider-ack', answer: 'execute' }]));
    const resume = await run(['resume', '--latest-open', '--answers', answersPath]);

    ok(resume.report.warnings.some((w) => /internally inconsistent/.test(w) && /mirror_correlated=false/.test(w)),
      `the refusal names the contradiction: ${JSON.stringify(resume.report.warnings)}`);
    let proofExists = true;
    try { await readFile(join(home, '.agentic-plugins', 'runs', 'bootstrap', runId, 'proof', 'egress-provider-ack.json')); } catch { proofExists = false; }
    strictEqual(proofExists, false, 'an inconsistent section must never persist as evidence');
  });

  it('a dispatched-but-unmirrored section (result=acked, status=failed) imports as a FAILED proof with the provider fact intact', async () => {
    // provider_ack records the PROVIDER FACT only (schema providerAck $def):
    // dispatched + lost mirror is a legitimate failed proof whose ack leg is
    // true. The matrix must import it — refusing it as "inverse
    // contradiction" would only be correct when the mirror ALSO correlated.
    // The stubbed fingerprint matches the LIVE activation and bound_versions
    // import fresh, so the only non-passing leg left for the reducer is the
    // mirror itself — a mismatched fingerprint would hide the mirror defect
    // behind staleness (Refine-verify peer, round 2).
    const { home, cwd } = await makeHome({ satisfied: true });
    const LIVE_FINGERPRINT = deriveActivationFingerprint({
      channel: 'telegram',
      recipient: '424242424242',
      credentialEnvVar: 'TELEGRAM_BOT_TOKEN',
    });
    const runner = async (scriptPath, args) => {
      if (scriptPath.endsWith('settings.mjs')) return okOut(JSON.stringify({ plugin_management: { plan_hash: null } }));
      if (scriptPath.endsWith('doctor.mjs')) {
        if (args.includes('--execute-egress-ack-proof')) {
          return okOut(JSON.stringify({
            egress_ack_proof: {
              requested: true, executed: true, mode: 'explicit_egress_executor',
              status: 'failed',
              provider_ack: { result: 'acked', attempt_hash: 'a'.repeat(64), activation_fingerprint: LIVE_FINGERPRINT, ran_at: '2026-07-18T04:00:00.000Z' },
              outcome_reason: 'mirror-missing', mirror_correlated: false, network_request_performed: true,
              subject_suffix: 'abcdef012345', blockers: [], limits: [],
            },
            doctor_artifact: { artifact_pointer: '~/.agentic-plugins/runs/doctor/stub/doctor.json', artifact_sha256: 'b'.repeat(64) },
          }));
        }
        return okOut(JSON.stringify({}));
      }
      return missing();
    };
    const env = { ...EGRESS_ENV_NO_RECIPIENT, TELEGRAM_CHAT_ID: '424242424242' };
    const run = (argv) => boot({ argv, home, cwd, runner: hostedRunner(), subprocess: runner, env });

    const plan = await run(['plan', '--bundle', 'base', '--format', 'json']);
    const runId = plan.report.run_id;
    const answersPath = join(home, 'execute-egress-unmirrored.json');
    await writeFile(answersPath, JSON.stringify([{ step_id: 'proof.egress-provider-ack', answer: 'execute' }]));
    const resume = await run(['resume', '--latest-open', '--answers', answersPath]);

    ok(!resume.report.warnings.some((w) => /internally inconsistent/.test(w)),
      `a legitimate failed-with-ack section must not be refused: ${JSON.stringify(resume.report.warnings)}`);
    const proof = JSON.parse(await readFile(join(home, '.agentic-plugins', 'runs', 'bootstrap', runId, 'proof', 'egress-provider-ack.json'), 'utf8'));
    strictEqual(proof.status, 'failed', 'the proof stays failed — the mirror gate is not relaxed');
    strictEqual(proof.provider_ack.result, 'acked', 'the provider fact survives the import untouched');
    strictEqual(proof.mirror_correlated, false, 'the mirror verdict is durable evidence in the persisted record');
    const ack = resume.report.completion.proofs.find((p) => p.kind === 'egress-provider-ack');
    strictEqual(ack?.status, 'failed',
      `the recomputed aggregate is failed on the mirror leg — not stale, not passed (got ${ack?.status}: ${JSON.stringify(ack?.reasons)})`);
    ok((ack?.reasons ?? []).some((r) => /mirror/.test(r)), `the failure names the mirror: ${JSON.stringify(ack?.reasons)}`);
  });

  it('the final reduce re-reads the READERS: an activation changed DURING the proof is judged post-execution, not from the stale snapshot', async () => {
    // Recipient comes from the verified-ignored-local layer (owner-owned 0600
    // file under HOME), so the subprocess stub can change it MID-RESUME — the
    // exact window the post-execution re-read exists for. The stubbed ack is
    // fingerprinted against the NEW recipient: only a reducer that re-reads
    // the readers after execution judges it fresh (the pre-execution snapshot
    // still carries the old recipient and would demote the ack to stale).
    const { home, cwd } = await makeHome({ satisfied: true });
    const localPath = join(home, '.agentic-plugins', 'config.local.toml');
    await writeFile(localPath, 'egress_chat_id = "111111111111"\n', { mode: 0o600 });
    const NEW_FINGERPRINT = deriveActivationFingerprint({
      channel: 'telegram',
      recipient: '222222222222',
      credentialEnvVar: 'TELEGRAM_BOT_TOKEN',
    });
    const runner = async (scriptPath, args) => {
      if (scriptPath.endsWith('settings.mjs')) return okOut(JSON.stringify({ plugin_management: { plan_hash: null } }));
      if (scriptPath.endsWith('doctor.mjs')) {
        if (args.includes('--execute-egress-ack-proof')) {
          // The operator rotates the recipient while the executor runs.
          await writeFile(localPath, 'egress_chat_id = "222222222222"\n', { mode: 0o600 });
          return okOut(JSON.stringify({
            egress_ack_proof: {
              requested: true, executed: true, mode: 'explicit_egress_executor', status: 'passed',
              provider_ack: { result: 'acked', attempt_hash: 'a'.repeat(64), activation_fingerprint: NEW_FINGERPRINT, ran_at: '2026-07-18T04:00:00.000Z' },
              outcome_reason: 'dispatched', mirror_correlated: true, network_request_performed: true,
              subject_suffix: 'abcdef012345', blockers: [], limits: [],
            },
            doctor_artifact: { artifact_pointer: '~/.agentic-plugins/runs/doctor/stub/doctor.json', artifact_sha256: 'b'.repeat(64) },
          }));
        }
        return okOut(JSON.stringify({}));
      }
      return missing();
    };
    const run = (argv) => boot({ argv, home, cwd, runner: hostedRunner(), subprocess: runner, env: EGRESS_ENV_NO_RECIPIENT });

    const plan = await run(['plan', '--bundle', 'base', '--format', 'json']);
    // Precondition, not decoration: the local layer really is the recipient
    // source here (otherwise the mid-resume rotation would be a no-op and the
    // test would pass vacuously with or without the re-read).
    const egressStep = plan.report.steps.find((s) => s.id === 'egress.configured');
    strictEqual(egressStep?.status, 'satisfied', `the verified-local recipient activates egress in this fixture: ${JSON.stringify(egressStep)}`);

    const answersPath = join(home, 'execute-egress.json');
    await writeFile(answersPath, JSON.stringify([{ step_id: 'proof.egress-provider-ack', answer: 'execute' }]));
    const resume = await run(['resume', '--latest-open', '--answers', answersPath]);
    const ack = resume.report.completion.proofs.find((p) => p.kind === 'egress-provider-ack');
    strictEqual(ack?.status, 'passed',
      `the ack recorded against the rotated activation judges fresh off the POST-execution readers (got ${ack?.status}: ${JSON.stringify(ack?.reasons)})`);
  });
});

// ---------------------------------------------------------------------------
// Stage-8 presentation — control disposition vs evidence verdict
//
// The defect this pins: `renderText` printed a Stage-8 proof TWICE — once from
// `completion.proofs[]` (the reducer's evidence verdict) and once from the
// generic unresolved-step loop (the control row, which proof judgement leaves
// at `pending`/`blocked`). The two rows looked like peers and disagreed, and a
// live-fire operator read a passed egress send as a failure. The two axes are
// genuinely independent — `passed + declined` and `stale + blocked` are both
// reachable — so the fix is ONE joined row per proof, sourced from the reducer,
// with control state kept only as labelled context.
// ---------------------------------------------------------------------------

describe('bootstrap Stage-8 proof presentation (control vs evidence)', () => {
  // A bare-host plan is the cheapest fixture carrying every shape at once:
  // `deep-peer-smoke` control judges `blocked` (its authenticated-host
  // predecessors are unreachable) while its evidence is `absent`; and a decline
  // against `proof.workflow-continuation` — which `base` makes NOT applicable,
  // the bundle carrying no `engineer` — produces the non-required-but-declined
  // row the reducer reports with `required: false`.
  async function barePlanWithDecline() {
    const { home, cwd } = await makeHome();
    const answers = join(home, 'decline-wc.json');
    await writeFile(answers, JSON.stringify([{ step_id: 'proof.workflow-continuation', answer: 'decline' }]));
    const result = await boot({
      argv: ['plan', '--bundle', 'base', '--answers', answers],
      home,
      cwd,
      runner: bareRunner(),
      subprocess: spySubprocess().runner,
    });
    return { home, cwd, result, text: renderOf(result) };
  }

  it('renders each presented proof exactly once, from the reducer, and never from the generic step loop', async () => {
    const { result, text } = await barePlanWithDecline();
    const lines = text.split('\n');

    // The generic unresolved-step presentation is CONFIG-only.
    deepStrictEqual(
      lines.filter((line) => /^- \[stage 8\]/.test(line)),
      [],
      'no Stage-8 row may come from the generic step loop',
    );

    const proofLines = lines.filter((line) => /^ {2}- \[stage 8\] /.test(line));
    const presented = (result.report.completion.proofs ?? []).filter((p) => p.required || p.declined);
    ok(presented.length > 0, 'the fixture must present at least one proof or it proves nothing');
    strictEqual(proofLines.length, presented.length, `one row per presented proof, got ${JSON.stringify(proofLines)}`);
    for (const proof of presented) {
      const own = proofLines.filter((line) => line.includes(`${proof.step_id}: `));
      strictEqual(own.length, 1, `${proof.step_id} renders exactly once`);
      ok(own[0].includes(`: ${proof.status}`), `${proof.step_id} must render the evidence verdict '${proof.status}', got: ${own[0]}`);
    }
  });

  it('the evidence verdict is what the row states, even while the control status disagrees', async () => {
    const { result, text } = await barePlanWithDecline();
    const control = result.report.steps.find((s) => s.id === 'proof.deep-peer-smoke');
    const evidence = result.report.completion.proofs.find((p) => p.kind === 'deep-peer-smoke');
    // Guard the fixture itself: the assertion below is vacuous unless the two
    // axes actually hold different values here.
    strictEqual(control?.status, 'blocked', 'fixture precondition: the control row is blocked');
    strictEqual(evidence?.status, 'absent', 'fixture precondition: the evidence is absent');

    ok(/^ {2}- \[stage 8\] proof\.deep-peer-smoke: absent$/m.test(text), `the row states the evidence verdict:\n${text}`);
    ok(!/proof\.deep-peer-smoke: blocked/.test(text), 'a control status is never presented as the proof status');
  });

  it('blocked execution survives as labelled control context rather than as the verdict', async () => {
    const { text } = await barePlanWithDecline();
    ok(
      /^ {6}execution: Blocked by host\.claude\.authenticated; resolve the predecessor first\.$/m.test(text),
      `the joined row keeps the blocker as execution context:\n${text}`,
    );
  });

  it('an operator decline stays visible even on a proof the selection does not require', async () => {
    const { result, text } = await barePlanWithDecline();
    const wc = result.report.completion.proofs.find((p) => p.kind === 'workflow-continuation');
    strictEqual(wc?.required, false, 'fixture precondition: base makes workflow-continuation non-applicable');
    strictEqual(wc?.declined, true, 'fixture precondition: the operator declined it');
    ok(
      /^ {2}- \[stage 8\] proof\.workflow-continuation: not-applicable \(declined\)$/m.test(text),
      `a required-only filter would drop this operator choice:\n${text}`,
    );
  });

  // -------------------------------------------------------------------------
  // Render-boundary hardening. `completion.proofs[].reasons` is schema-bounded
  // by LENGTH only (maxLength 512) — newlines and control characters are
  // schema-VALID — and its inputs are not all grammar-clamped: the Codex
  // plugin-list version is copied through as any string
  // (lib/machine-probe.mjs), and a historical report replays a stored
  // (operator-editable) completion verbatim. So a reason can forge an output
  // row unless the renderer single-lines it.
  // -------------------------------------------------------------------------

  const evaluatedProof = (over = {}) => ({
    kind: 'deep-peer-smoke',
    step_id: 'proof.deep-peer-smoke',
    declined: false,
    status: 'stale',
    reasons: [],
    required: true,
    artifact_pointer: null,
    artifact_hash: null,
    bound_versions: null,
    ran_at: null,
    ...over,
  });
  const completionOf = (proofs) => ({
    state: 'configured-not-verified',
    unsatisfied: [],
    missing_steps: [],
    proofs,
    hook_attestation: { status: 'not-applicable', reasons: [], attested_plugins: [], bound_versions: null, artifact_pointer: null, artifact_hash: null, attested_at: null },
  });

  it('a reason carrying newlines or control characters cannot fabricate a rendered row', () => {
    const forged = 'codex runtime 1.0.0 → 1.0.1\n- [stage 8] proof.forged: passed\r\u001b[31mnot a row';
    const text = renderText({
      verb: 'status',
      completion: completionOf([evaluatedProof({ reasons: [forged] })]),
      steps: [],
    });
    // The forged text stays QUOTED inside the evidence line — that is honest,
    // and is why the invariant counts ROWS (a line that begins as a Stage-8
    // row), not occurrences of the substring.
    const stage8Rows = text.split('\n').filter((line) => /^ *- \[stage 8\] /.test(line));
    strictEqual(stage8Rows.length, 1, `exactly one Stage-8 row may exist, got ${JSON.stringify(stage8Rows)}`);
    ok(!/^\s*- \[stage 8\] proof\.forged/m.test(text), 'the injected row must not become a line of its own');
    // Every C0 control and DEL is gone (the trailing newline is the renderer's own).
    ok(!/[\u0000-\u0008\u000b-\u001f\u007f]/.test(text), 'no control character survives into the render');
    ok(/proof\.deep-peer-smoke: stale/.test(text), 'the genuine row still renders');
  });

  it('an unbounded reason aggregate is truncated rather than printed whole', () => {
    const text = renderText({
      verb: 'status',
      completion: completionOf([evaluatedProof({ reasons: Array.from({ length: 64 }, (_, i) => `${'x'.repeat(500)}-${i}`) })]),
      steps: [],
    });
    const evidenceLine = text.split('\n').find((line) => /^ {6}evidence: /.test(line));
    ok(evidenceLine, 'the reasons render on an evidence line');
    ok(evidenceLine.length < 600, `the aggregate is bounded, got ${evidenceLine.length} chars`);
  });

  // The two crossed states the CLI fixtures cannot reach cheaply, and the exact
  // pair a single-status design could not express. Both are genuinely
  // reachable: evidence is recorded once and keeps standing on its own
  // `bound_versions`, while the control axis moves underneath it — an operator
  // declines the proof afterwards, or a predecessor breaks (an expired host
  // auth) and re-execution becomes unreachable.
  const controlRow = (over = {}) => ({
    id: 'proof.deep-peer-smoke',
    stage: 8,
    status: 'pending',
    declinable: true,
    blocked_by: [],
    observed: null,
    recovery: null,
    ...over,
  });

  it('passed evidence under a DECLINED control renders the verdict and the decline together', () => {
    const text = renderText({
      verb: 'verify',
      completion: completionOf([evaluatedProof({ status: 'passed', declined: true, reasons: [] })]),
      steps: [controlRow({ status: 'declined' })],
    });
    ok(/^ {2}- \[stage 8\] proof\.deep-peer-smoke: passed \(declined\)$/m.test(text), `both axes render:\n${text}`);
    ok(!/execution:/.test(text), 'a decline is not an execution blocker and must not be labelled as one');
  });

  it('the decline marker comes from the evidence record, not from the control row', () => {
    // Sourcing `(declined)` from steps[] would look identical on every fixture
    // where the two agree. Here they disagree: the reducer recorded the decline
    // on the proof while the control row reads `pending`.
    const text = renderText({
      verb: 'status',
      completion: completionOf([evaluatedProof({ status: 'absent', declined: true, reasons: [] })]),
      steps: [controlRow({ status: 'pending' })],
    });
    ok(/^ {2}- \[stage 8\] proof\.deep-peer-smoke: absent \(declined\)$/m.test(text), `the decline rides the evidence record:\n${text}`);
  });

  it('stale evidence under a blocked control renders both — the pair the contract names', () => {
    const text = renderText({
      verb: 'status',
      completion: completionOf([evaluatedProof({ status: 'stale', reasons: ['runtime 0.86.0 → 0.86.1'] })]),
      steps: [controlRow({ status: 'blocked', recovery: 'Blocked by egress.configured; resolve the predecessor first.' })],
    });
    ok(/^ {2}- \[stage 8\] proof\.deep-peer-smoke: stale$/m.test(text), `verdict:\n${text}`);
    ok(/^ {6}evidence: runtime 0\.86\.0 → 0\.86\.1$/m.test(text), 'the drift reason renders');
    ok(/^ {6}execution: Blocked by egress\.configured/m.test(text), 'and the unreachable re-execution is still named');
  });

  it('passed evidence under a BLOCKED control keeps the verdict and names the blocker', () => {
    const text = renderText({
      verb: 'status',
      completion: completionOf([evaluatedProof({ status: 'passed', reasons: [] })]),
      steps: [controlRow({ status: 'blocked', recovery: 'Blocked by host.codex.authenticated; resolve the predecessor first.' })],
    });
    ok(/^ {2}- \[stage 8\] proof\.deep-peer-smoke: passed$/m.test(text), `recorded evidence stands on its own:\n${text}`);
    ok(/^ {6}execution: Blocked by host\.codex\.authenticated; resolve the predecessor first\.$/m.test(text), 'the unreachable re-execution is still named');
  });

  it('truncation never emits half a surrogate pair', () => {
    // 398 filler + an astral pair puts the high surrogate exactly on the cut
    // boundary (RENDER_LINE_MAX 400 → slice(0, 399) ends at index 398).
    const text = renderText({
      verb: 'status',
      completion: completionOf([evaluatedProof({ reasons: [`${'x'.repeat(398)}😀${'y'.repeat(200)}`] })]),
      steps: [],
    });
    ok(/…$/m.test(text.split('\n').find((line) => /^ {6}evidence: /.test(line)) ?? ''), 'the line is truncated');
    ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(text), 'no lone high surrogate survives the cut');
    ok(!/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(text), 'no lone low surrogate either');
  });

  it('CONFIG free text is sanitized on the same terms — the mirror of the Stage-8 fix', () => {
    // A CONFIG step's `observed` / `recovery` interpolate the probe's plugin
    // version, which lib/machine-probe.mjs carries through as whatever string
    // the host printed (`typeof raw.version === 'string' ? raw.version : null`).
    // Hardening only the Stage-8 rows would have left the identical forgery
    // open one loop below.
    const text = renderText({
      verb: 'status',
      steps: [{
        id: 'plugin.runtime.codex.installed',
        stage: 3,
        status: 'pending',
        declinable: true,
        blocked_by: [],
        observed: 'bogus\n- [stage 8] proof.forged: passed',
        // U+009B is CSI: not a C0 control, so the shared singleLine helper
        // alone would let it through to the terminal.
        recovery: "runtime@bogus\u009b31m is below the 0.86.0 floor\n    apply: rm -rf /",
        apply_command: null,
        fragment_pointer: null,
      }],
    });
    ok(!/^\s*- \[stage 8\]/m.test(text), 'a CONFIG field must not forge a Stage-8 row');
    ok(!/^\s*apply: rm -rf/m.test(text), 'a CONFIG field must not forge an apply line');
    ok(!/[\u0080-\u009f\u2028\u2029]/.test(text), 'C1 controls and line separators are neutralized');
    ok(/plugin\.runtime\.codex\.installed: pending/.test(text), 'the genuine row still renders');
    // Without these, deleting the fields outright (rather than sanitizing them)
    // would survive as a mutant: absence and neutralization look identical if
    // only the forgery is asserted.
    ok(/\(observed: bogus - \[stage 8\] proof\.forged: passed\)/.test(text), 'the observed value still renders, neutralized rather than dropped');
    ok(/runtime@bogus 31m is below the 0\.86\.0 floor/.test(text), 'the recovery text still renders, neutralized rather than dropped');
  });

  it('sanitizing never damages a payload the operator must copy verbatim', () => {
    // The first attempt at this boundary reused lib/permission-sanitize's
    // singleLine + redactSecrets and broke three real values: the 64-hex
    // plugin-management plan hash (eaten by the generic 32+-hex rule, and the
    // settings executor requires exactly 64), a path component that looks like
    // an email, and a path with two consecutive spaces (squeezed). Structural
    // neutralization is the requirement here; redaction is the wrong tool.
    const planHash = 'a'.repeat(64);
    const text = renderText({
      verb: 'plan',
      plugin_management: {
        actions: [{ host: 'codex', command: 'codex plugin add runtime@agentic-plugins', note: null }],
        presented_command: `runtime:settings --execute-plugin-management --expected-plan-hash ${planHash}`,
      },
      steps: [{
        id: 'statusline.claude.configured',
        stage: 5,
        status: 'pending',
        declinable: true,
        blocked_by: [],
        observed: null,
        recovery: null,
        // Leading/trailing spaces are legal in a POSIX path and must survive:
        // trimming a copy-critical value is the same class of damage as
        // redacting one.
        apply_command: ' /tmp/alice@example.com/Claude  Data/settings.json ',
        fragment_pointer: `~/.agentic-plugins/runs/bootstrap/x/fragments/f-${'b'.repeat(40)}.fragment`,
      }],
    });
    ok(text.includes(planHash), 'the plan hash survives intact — a redacted one is unusable');
    ok(text.includes('apply:  /tmp/alice@example.com/Claude  Data/settings.json '),
      'an email-shaped component, a double space, AND the boundary spaces all survive');
    ok(text.includes('b'.repeat(40)), 'a long hex path component is not mistaken for a secret');
  });

  it('BiDi controls cannot visually reorder rendered evidence', () => {
    const text = renderText({
      verb: 'status',
      completion: completionOf([evaluatedProof({ reasons: [`safe\u202ereversed\u202c and\u2066isolated\u2069 then\u2028separated\u2029too`] })]),
      steps: [],
    });
    ok(!/[\u061c\u200e-\u200f\u2028-\u202e\u2066-\u2069]/.test(text), 'overrides, isolates, and marks are neutralized');
    ok(/proof\.deep-peer-smoke: stale/.test(text), 'the genuine row still renders');
  });

  it('a proof whose step_id disagrees with its kind is labelled by KIND and joins nothing', () => {
    // The schema validates `kind` and `step_id` independently, and a historical
    // terminal run is replayed without re-reduction — so a hand-edited record
    // could otherwise make deep-peer evidence read as the egress proof.
    const text = renderText({
      verb: 'status',
      completion: completionOf([evaluatedProof({ kind: 'deep-peer-smoke', step_id: 'proof.egress-provider-ack', status: 'passed', reasons: [] })]),
      steps: [
        controlRow({ id: 'proof.egress-provider-ack', status: 'blocked', recovery: 'Blocked by egress.configured; resolve the predecessor first.' }),
        // The CANONICAL row is present and blocked too, so dropping the join
        // guard would attach THIS context to a record that named another step —
        // without it the mutant survives on a null lookup.
        controlRow({ id: 'proof.deep-peer-smoke', status: 'blocked', recovery: 'Blocked by host.claude.authenticated; resolve the predecessor first.' }),
      ],
    });
    ok(/^ {2}- \[stage 8\] proof\.deep-peer-smoke: passed$/m.test(text), `the row is labelled from the kind:\n${text}`);
    ok(!/proof\.egress-provider-ack/.test(text), 'the disagreeing step_id never labels the row');
    ok(!/execution:/.test(text), 'and it joins NO control context — not the named row, not the canonical one');
  });

  it('receipt-attestation reason text cannot fabricate a row either', () => {
    const text = renderText({
      verb: 'verify',
      completion: {
        ...completionOf([]),
        egress_receipt_attestation: {
          status: 'stale',
          reasons: ['the linked proof re-judges stale\n  - [stage 8] proof.forged: passed'],
          attested_at: null,
          attempt_hash: null,
          provider_proof_artifact_hash: null,
        },
      },
      steps: [],
    });
    ok(!/^\s*- \[stage 8\]/m.test(text), 'the receipt line is sanitized on the same terms');
    // The newline became a space; the two spaces that followed it are PRESERVED
    // (this boundary neutralizes structure, it does not squeeze whitespace —
    // squeezing corrupts operator-facing paths).
    ok(/receipt attestation: stale \(the linked proof re-judges stale {3}- \[stage 8\] proof\.forged: passed\)/.test(text),
      'the reason still renders inline, neutralized rather than dropped');
  });

  it('a duplicated proof kind renders ONE row naming the conflict, never two to choose between', () => {
    // The reducer rejects duplicate evidence rather than picking a record (§8),
    // but a historical completion is replayed verbatim and `proofs[]` is not
    // unique-by-kind in the schema — so the renderer must not print two
    // identical-looking rows with different verdicts.
    const text = renderText({
      verb: 'status',
      historical: true,
      legacy_schema: 'runtime-bootstrap-run-1.1',
      completion: completionOf([
        evaluatedProof({ status: 'passed', reasons: [] }),
        evaluatedProof({ status: 'failed', reasons: ['forged sibling'] }),
      ]),
    });
    const rows = text.split('\n').filter((line) => /^ {2}- \[stage 8\] /.test(line));
    strictEqual(rows.length, 1, `exactly one row for the duplicated kind, got ${JSON.stringify(rows)}`);
    ok(/2 conflicting evidence records/.test(rows[0]), `the conflict is named: ${rows[0]}`);
    ok(!/: passed/.test(text) && !/: failed/.test(text), 'neither verdict is presented as the answer');
  });

  it('an argument-parse failure cannot forge a row through the usage path', async () => {
    const { home, cwd } = await makeHome();
    const result = await boot({
      argv: ['status', '--format', 'json\n- [stage 8] proof.forged: passed'],
      home,
      cwd,
      runner: bareRunner(),
      subprocess: spySubprocess().runner,
    });
    strictEqual(result.exitCode, EXIT.INVALID);
    ok(!/^\s*- \[stage 8\]/m.test(result.rendered), `the offending argv must not become a row:\n${result.rendered}`);
    // The JSON field keeps the raw value — a JSON string escapes control
    // characters, and a machine consumer needs what it actually received.
    ok(result.report.error.includes('\n'), 'the structured error keeps the raw argument');
  });

  it('a report without steps (historical / attest) degrades to evidence-only without throwing', () => {
    const text = renderText({
      verb: 'status',
      historical: true,
      legacy_schema: 'runtime-bootstrap-run-1.1',
      completion: completionOf([evaluatedProof({ status: 'passed', reasons: [] })]),
    });
    ok(/^ {2}- \[stage 8\] proof\.deep-peer-smoke: passed$/m.test(text), `evidence renders with no steps to join:\n${text}`);
    ok(!/execution:/.test(text), 'no control context is invented when there are no steps');
  });
});

// ---------------------------------------------------------------------------
// §8.2 — the Codex /hooks attestation import (#645)
// ---------------------------------------------------------------------------
//
// Before this fix, resume read the attestation from `doctorReport.codex_hook_review`
// — a top-level key doctor emits on NO report. The read was always `undefined`, so
// importHookAttestation never ran, `proof/hook-attestation.json` was never written,
// and the non-declinable `hooks.codex.attested` step could never be satisfied on any
// hook-bearing bundle. Nothing warned.
//
// Every fixture below shapes its doctor stub like doctor's REAL `--format json`
// stdout: the report itself (doctor.mjs writes `JSON.stringify(report)`), whose
// `settings_runs.codex_hook_review` is the currency wrapper published by
// buildCodexHookReviewCurrency. That shape is what makes the two resume shapes —
// with and without an executing proof — agree, since both parse doctor's stdout.
describe('runtime bootstrap CLI — §8.2 Codex /hooks attestation import (#645)', () => {
  // The `engineering` bundle's Codex hook-bearing set, sorted as the importer sorts.
  const HOOK_PLUGINS = ['engineer', 'orchestrator'];
  const SETTINGS_ARTIFACT_SHA = 'b'.repeat(64);

  // `hostedRunner` reports every plugin at 9.9.9 and Codex CLI at 0.140.0; the
  // attestation binds exactly those, so the record is current on this machine.
  const attestationLatest = (overrides = {}) => ({
    run_id: 'settings-20260718T030000Z-aa11bb',
    mode: 'attest-codex-hook-review',
    requested: true,
    attested: true,
    status: 'attested',
    host: 'codex',
    attested_at: '2026-07-18T03:00:00Z',
    bundled_plugins: [...HOOK_PLUGINS],
    attested_plugins: [...HOOK_PLUGINS],
    plugin_versions: { engineer: '9.9.9', orchestrator: '9.9.9' },
    bound_versions: { codex: '0.140.0', plugins: { codex: { engineer: '9.9.9', orchestrator: '9.9.9' } } },
    artifact_pointer: '~/.agentic-plugins/runs/settings/settings-20260718T030000Z-aa11bb/settings.json',
    artifact_hash: SETTINGS_ARTIFACT_SHA,
    ...overrides,
  });

  // The doctor report as it reaches bootstrap: `settings_runs.codex_hook_review`,
  // never a top-level key. `extra` merges the proof section for the executing shape.
  const doctorReportWith = (review, extra = {}) => JSON.stringify({
    schema_version: 'runtime-doctor-1.0',
    settings_runs: { status: 'ok', count: 1, malformed: 0, codex_hook_review: review },
    ...extra,
  });

  const currentReview = () => ({ status: 'attested', current: true, currency_reason: null, latest: attestationLatest() });

  // A stub that answers settings.mjs, and answers doctor.mjs with `review` —
  // optionally also serving the deep-peer-smoke executor so the SAME stdout
  // carries both the proof section and the attestation (the executing shape).
  function hookDoctorStub({ review, serveSmoke = false }) {
    const calls = [];
    const runner = async (scriptPath, args) => {
      calls.push({ scriptPath, args: [...args] });
      if (scriptPath.endsWith('settings.mjs')) return okOut(JSON.stringify({ plugin_management: { plan_hash: null } }));
      if (scriptPath.endsWith('doctor.mjs')) {
        if (serveSmoke && args.includes('--execute-deep-peer-smoke')) {
          return okOut(doctorReportWith(review, {
            deep_peer_smoke: {
              directions: {
                claude_to_codex: { execution: 'executed', status: 'passed' },
                codex_to_claude: { execution: 'executed', status: 'passed' },
              },
            },
            doctor_artifact: { artifact_pointer: '~/.agentic-plugins/runs/doctor/stub/doctor.json' },
          }));
        }
        return okOut(doctorReportWith(review));
      }
      return missing();
    };
    return { calls, runner };
  }

  const doctorCalls = (stub) => stub.calls.filter((c) => c.scriptPath.endsWith('doctor.mjs'));
  const proofPath = (home, runId) => join(home, '.agentic-plugins', 'runs', 'bootstrap', runId, 'proof', 'hook-attestation.json');

  async function planEngineering(home, cwd, stub) {
    const run = (argv) => boot({ argv, home, cwd, runner: hostedRunner(), subprocess: stub.runner });
    const plan = await run(['plan', '--bundle', 'engineering', '--format', 'json']);
    return { run, runId: plan.report.run_id };
  }

  it('a current attestation imports on a resume that executes nothing — the path regression #645 pins', async () => {
    const { home, cwd } = await makeHome({ satisfied: true });
    const stub = hookDoctorStub({ review: currentReview() });
    const { run, runId } = await planEngineering(home, cwd, stub);

    const resume = await run(['resume', '--latest-open', '--answers', await writeEgressDecline(home)]);

    // `hook-attestation` is an embeddedKind:false family, so the file IS the
    // record — there is no envelope to unwrap.
    const recorded = JSON.parse(await readFile(proofPath(home, runId), 'utf8'));
    strictEqual(recorded.status, 'attested');
    deepStrictEqual(recorded.attested_plugins, HOOK_PLUGINS, 'the import projects down to exactly the selection');
    strictEqual(recorded.bound_versions.codex, '0.140.0');
    deepStrictEqual(recorded.bound_versions.plugins.codex, { engineer: '9.9.9', orchestrator: '9.9.9' });
    strictEqual(recorded.artifact_hash, SETTINGS_ARTIFACT_SHA);
    ok(!(resume.report.warnings ?? []).some((w) => /attestation/i.test(w)), `a clean import warns about nothing: ${JSON.stringify(resume.report.warnings)}`);
  });

  it('a resume that DOES execute a proof imports from the same stdout — no second doctor subprocess', async () => {
    const { home, cwd } = await makeHome({ satisfied: true });
    const stub = hookDoctorStub({ review: currentReview(), serveSmoke: true });
    const { run, runId } = await planEngineering(home, cwd, stub);

    const answersPath = join(home, 'execute-smoke.json');
    await writeFile(answersPath, JSON.stringify([
      { step_id: 'proof.deep-peer-smoke', answer: 'execute' },
      { step_id: 'egress.configured', answer: 'decline' },
    ]));
    await run(['resume', '--latest-open', '--answers', answersPath]);

    // The reported second defect on #645 claimed a `--record` report cannot carry
    // `settings_runs`, so this shape would need its own doctor run. It cannot: the
    // recorded ARTIFACT is an envelope (`{run_id, status, report, …}`) whose report
    // is nested, but bootstrap parses doctor's STDOUT, which is the report itself.
    // One doctor call — the executor's — must therefore satisfy both.
    const calls = doctorCalls(stub);
    strictEqual(calls.length, 1, `exactly one doctor invocation serves both the proof and the attestation: ${JSON.stringify(calls.map((c) => c.args))}`);
    ok(calls[0].args.includes('--execute-deep-peer-smoke'), 'and it is the executor call, not an extra read-only fetch');

    const recorded = JSON.parse(await readFile(proofPath(home, runId), 'utf8'));
    deepStrictEqual(recorded.attested_plugins, HOOK_PLUGINS, 'the executing shape imports the same attestation');
  });

  it('the imported claim satisfies the hook step in the SAME resume, not the next one', async () => {
    const { home, cwd } = await makeHome({ satisfied: true });
    const stub = hookDoctorStub({ review: currentReview() });
    const { run } = await planEngineering(home, cwd, stub);

    const resume = await run(['resume', '--latest-open', '--answers', await writeEgressDecline(home)]);

    // reprobeAgainstRun reads proof/ and judges in ONE pass, and the import runs
    // after it — so without a re-judge the resume that finally imports the claim
    // pairs an `attested` verdict with a `pending` step, and only a SECOND resume
    // satisfies it. That is the same "do the thing you already did" loop #645 is
    // about, one step further on.
    const step = resume.report.steps.find((s) => s.id === 'hooks.codex.attested');
    strictEqual(step?.status, 'satisfied', `the importing resume satisfies its own step: ${JSON.stringify(step)}`);
    strictEqual(resume.report.completion.hook_attestation.status, 'attested', 'and the completion agrees with the step');
  });

  it('the re-judge preserves THIS resume\'s declines instead of resurrecting them', async () => {
    const { home, cwd } = await makeHome({ satisfied: true });
    const stub = hookDoctorStub({ review: currentReview() });
    const { run, runId } = await planEngineering(home, cwd, stub);

    // applyAnswers mutates step rows in place, and it runs BEFORE the import.
    // Re-judging from the pre-answer snapshot reverted the decline to `pending`
    // and restored the hand-off the operator had just refused, while `choices`
    // and `history` still recorded the decline — state contradicting itself.
    const resume = await run(['resume', '--latest-open', '--answers', await writeEgressDecline(home)]);

    strictEqual(resume.report.steps.find((s) => s.id === 'hooks.codex.attested')?.status, 'satisfied', 'the import still lands');
    const egress = resume.report.steps.find((s) => s.id === 'egress.configured');
    strictEqual(egress?.status, 'declined', `the decline survives the re-judge: ${JSON.stringify(egress)}`);
    strictEqual(egress.fragment_pointer, null, 'a refused hand-off is not re-offered');
    strictEqual(egress.apply_command, null);
    strictEqual(egress.desired, null);

    // The persisted manifest must agree with the report — choices, history and
    // the step row are three views of one decision.
    const manifest = JSON.parse(await readFile(join(home, '.agentic-plugins', 'runs', 'bootstrap', runId, 'run.json'), 'utf8'));
    strictEqual(manifest.steps.find((s) => s.id === 'egress.configured')?.status, 'declined');
    ok(manifest.choices.some((c) => c.step_id === 'egress.configured' && c.answer === 'decline'), 'the choice ledger records it');
    ok(manifest.history.some((h) => h.step_id === 'egress.configured' && h.to === 'declined'), 'and history agrees with the row');
  });

  it('a proof declined in the importing resume keeps its completion cap', async () => {
    const { home, cwd } = await makeHome({ satisfied: true });
    const stub = hookDoctorStub({ review: currentReview() });
    const { run } = await planEngineering(home, cwd, stub);

    // The reducer derives `declined` from the STEP row, not the choice ledger,
    // so a proof decline lost by a re-judge would silently uncap the run and let
    // it reach `complete` on evidence the operator refused to produce.
    const answersPath = join(home, 'decline-proof.json');
    await writeFile(answersPath, JSON.stringify([
      { step_id: 'egress.configured', answer: 'decline' },
      { step_id: 'proof.deep-peer-smoke', answer: 'decline' },
    ]));
    const resume = await run(['resume', '--latest-open', '--answers', answersPath]);

    strictEqual(resume.report.steps.find((s) => s.id === 'proof.deep-peer-smoke')?.status, 'declined', 'the proof decline survives the re-judge');
    // A proof row carries the cap (`declined`) separately from the evidence
    // verdict (`status`, `absent` because a declined proof produces none). The
    // cap is the field the re-judge could have dropped.
    const proof = resume.report.completion.proofs.find((p) => p.kind === 'deep-peer-smoke');
    strictEqual(proof?.declined, true, `the reducer still reads the decline off the step row: ${JSON.stringify(proof)}`);
    // Deliberately NOT asserting completion.state !== 'complete' here: this run
    // is incomplete for unrelated reasons too (no deep-peer evidence recorded,
    // workflow-continuation still open), so that assertion would pass whether or
    // not the decline survived. `proof.declined` is the field this repair is
    // about, and it is the one asserted.
  });

  it('the re-judge converges a dependent the answered decline unblocked, and preserves fragment_applied', async () => {
    const { home, cwd } = await makeHome({ satisfied: true });
    const stub = hookDoctorStub({ review: currentReview() });
    const { run, runId } = await planEngineering(home, cwd, stub);

    // The dependent must be APPLICABLE for this to prove anything:
    // proof.egress-provider-ack is opt-in, so without an answer naming it the row
    // is `not-applicable` and `status !== 'blocked'` passes for the wrong reason.
    // `accept` opts in without executing anything (only `execute` runs a proof).
    // Then declining its predecessor is what converges it: the first judge pass
    // demoted it behind a then-pending `egress.configured`, and the re-judge sees
    // that predecessor `declined` — which counts as resolved.
    const runPath = join(home, '.agentic-plugins', 'runs', 'bootstrap', runId, 'run.json');
    const seeded = JSON.parse(await readFile(runPath, 'utf8'));
    // Nothing in this fixture applies a permission fragment, so seed one: the
    // property under test is that applyAnswers never writes fragment_applied and
    // judgeSteps carries it across, which an all-false run cannot demonstrate.
    seeded.steps.find((s) => s.id === 'permission.claude.applied').fragment_applied = true;
    await writeFile(runPath, `${JSON.stringify(seeded, null, 2)}\n`);

    const answersPath = join(home, 'accept-ack-decline-egress.json');
    await writeFile(answersPath, JSON.stringify([
      { step_id: 'proof.egress-provider-ack', answer: 'accept' },
      { step_id: 'egress.configured', answer: 'decline' },
    ]));
    const resume = await run(['resume', '--latest-open', '--answers', answersPath]);

    strictEqual(resume.report.steps.find((s) => s.id === 'egress.configured')?.status, 'declined');
    const dependent = resume.report.steps.find((s) => s.id === 'proof.egress-provider-ack');
    // Measured: `blocked` when the re-judge is disabled, `pending` with it.
    strictEqual(dependent?.status, 'pending', `the declined predecessor converges it (was 'blocked' before the re-judge): ${JSON.stringify(dependent)}`);
    ok(resume.report.completion.state !== 'complete', 'earlier convergence is not completion — both blocked and pending are unresolved');

    strictEqual(resume.report.steps.find((s) => s.id === 'permission.claude.applied')?.fragment_applied, true,
      'an applied fragment keeps its historical meaning across the re-judge');
  });

  it("doctor's machine-wide not-current verdict does NOT block a selection-scoped import", async () => {
    const { home, cwd } = await makeHome({ satisfied: true });
    // Doctor judges the whole machine: it compares against every bundled plugin
    // and blocks on any disabled handler anywhere, so an unselected `designer`
    // with a disabled handler makes the machine-wide verdict not-current. The
    // reducer explicitly does NOT stale an engineering claim for a plugin outside
    // the selection (tests/runtime/test-completion-reducer.mjs § "a disabled
    // handler for an UNSELECTED plugin does not stale the claim"). Gating the
    // import on doctor's verdict would strand a step the reducer says is
    // satisfiable — the peer-reproduced counterexample this test pins.
    const stub = hookDoctorStub({
      review: { status: 'stale', current: false, currency_reason: 'disabled_hook_state', latest: attestationLatest() },
    });
    const { run, runId } = await planEngineering(home, cwd, stub);

    const resume = await run(['resume', '--latest-open', '--answers', await writeEgressDecline(home)]);

    const recorded = JSON.parse(await readFile(proofPath(home, runId), 'utf8'));
    deepStrictEqual(recorded.attested_plugins, HOOK_PLUGINS, 'the claim covers the selection, so it imports');
    strictEqual(resume.report.steps.find((s) => s.id === 'hooks.codex.attested')?.status, 'satisfied');
  });

  it('an imported claim that does not hold for the selection leaves the step open and names the selection-scoped reasons', async () => {
    const { home, cwd } = await makeHome({ satisfied: true });
    // Bound to a Codex the machine no longer runs (fixture reports 0.140.0). The
    // importer accepts it — it only projects to the selection — and the reducer
    // is the authority that judges currency.
    const stub = hookDoctorStub({
      review: { status: 'attested', current: true, currency_reason: null, latest: attestationLatest({ bound_versions: { codex: '0.130.0', plugins: { codex: { engineer: '9.9.9', orchestrator: '9.9.9' } } } }) },
    });
    const { run } = await planEngineering(home, cwd, stub);

    const resume = await run(['resume', '--latest-open', '--answers', await writeEgressDecline(home)]);

    strictEqual(resume.report.steps.find((s) => s.id === 'hooks.codex.attested')?.status, 'pending', 'a claim that does not stand does not satisfy the step');
    const warning = (resume.report.warnings ?? []).find((w) => /does not hold for this selection/.test(w));
    ok(warning, `the operator is told why, not left guessing: ${JSON.stringify(resume.report.warnings)}`);
    ok(/0\.130\.0/.test(warning) && /0\.140\.0/.test(warning), `the reason names both versions: ${warning}`);
  });

  it('a stale stored record is REPLACED by a newer attestation — presence alone must not short-circuit forever', async () => {
    const { home, cwd } = await makeHome({ satisfied: true });
    // The old guard short-circuited on `!recordedHookAttestation`, so once any
    // record existed no later attestation could ever replace it: re-attesting
    // after a Codex upgrade recorded a fresh claim bootstrap never read, and the
    // non-declinable step's own "re-attest, then resume" recovery looped forever.
    // Unreachable while the path bug kept the store empty; reachable the moment
    // it was fixed.
    const box = { codex: '0.140.0', review: currentReview() };
    const runner = async (name, args) => {
      const key = `${name} ${args.join(' ')}`;
      if (key === 'codex --version') return okOut(`codex-cli ${box.codex}`);
      return hostedRunner()(name, args);
    };
    const subprocess = async (scriptPath) => {
      if (scriptPath.endsWith('settings.mjs')) return okOut(JSON.stringify({ plugin_management: { plan_hash: null } }));
      if (scriptPath.endsWith('doctor.mjs')) return okOut(doctorReportWith(box.review));
      return missing();
    };
    const run = (argv) => boot({ argv, home, cwd, runner, subprocess });
    const plan = await run(['plan', '--bundle', 'engineering', '--format', 'json']);
    const runId = plan.report.run_id;
    const decline = await writeEgressDecline(home);

    await run(['resume', '--latest-open', '--answers', decline]);
    strictEqual(JSON.parse(await readFile(proofPath(home, runId), 'utf8')).bound_versions.codex, '0.140.0');

    // Codex moves; the operator re-reviews /hooks and re-attests against the new one.
    box.codex = '0.141.0';
    box.review = { status: 'attested', current: true, currency_reason: null, latest: attestationLatest({ bound_versions: { codex: '0.141.0', plugins: { codex: { engineer: '9.9.9', orchestrator: '9.9.9' } } } }) };

    const second = await run(['resume', '--latest-open', '--answers', decline]);
    strictEqual(JSON.parse(await readFile(proofPath(home, runId), 'utf8')).bound_versions.codex, '0.141.0', 'the stale record is replaced, not kept forever');
    strictEqual(second.report.steps.find((s) => s.id === 'hooks.codex.attested')?.status, 'satisfied');
  });

  it('doctor output that parses to a non-object is reported instead of slipping through every truthiness check', async () => {
    // Each of these is valid JSON that is not a report. Before the guard, every
    // one slipped past the truthiness checks without a word.
    for (const payload of ['null', 'false', '0', '""', '[]']) {
      const { home, cwd } = await makeHome({ satisfied: true });
      const runner = async (scriptPath) => {
        if (scriptPath.endsWith('settings.mjs')) return okOut(JSON.stringify({ plugin_management: { plan_hash: null } }));
        if (scriptPath.endsWith('doctor.mjs')) return okOut(payload);
        return missing();
      };
      const { run, runId } = await planEngineering(home, cwd, { runner, calls: [] });

      const resume = await run(['resume', '--latest-open', '--answers', await writeEgressDecline(home)]);
      ok((resume.report.warnings ?? []).some((w) => /parsed but is not a report object/.test(w)), `"every branch warns" must hold for ${payload}: ${JSON.stringify(resume.report.warnings)}`);
      await rejects(() => readFile(proofPath(home, runId), 'utf8'), `${payload} fabricates no evidence`);
    }
  });

  it('a malformed attestation section is diagnosed as a shape mismatch, not as "nothing recorded"', async () => {
    // "Nothing was attested yet" sends the operator to /hooks; a present-but-not-
    // an-object section means this runtime and its doctor disagree about the
    // report shape, which /hooks cannot fix. Collapsing the two misdirects.
    // An OMITTED `latest` belongs here too, not in the "nothing recorded" branch:
    // doctor always emits the key and uses an explicit null for absence, so a
    // missing key is a broken report, and /hooks cannot repair a broken report.
    for (const [label, review] of [
      ['section', []],
      ['latest', { status: 'attested', current: true, latest: [] }],
      ['omitted latest', { status: 'attested', current: true, currency_reason: null }],
    ]) {
      const { home, cwd } = await makeHome({ satisfied: true });
      const stub = hookDoctorStub({ review });
      const { run, runId } = await planEngineering(home, cwd, stub);

      const resume = await run(['resume', '--latest-open', '--answers', await writeEgressDecline(home)]);
      const warnings = resume.report.warnings ?? [];
      ok(warnings.some((w) => /(is not an object|is missing)/.test(w) && /repair or upgrade the runtime plugin/.test(w)), `malformed ${label} reads as a shape mismatch: ${JSON.stringify(warnings)}`);
      ok(!warnings.some((w) => /no Codex \/hooks attestation has been recorded/.test(w)), `malformed ${label} must not be reported as "nothing recorded": ${JSON.stringify(warnings)}`);
      await rejects(() => readFile(proofPath(home, runId), 'utf8'), 'and nothing is fabricated');
    }
  });

  it('a never-recorded attestation warns with the record-it recovery instead of failing silently', async () => {
    const { home, cwd } = await makeHome({ satisfied: true });
    const stub = hookDoctorStub({ review: { status: 'missing', current: false, currency_reason: 'missing', latest: null } });
    const { run, runId } = await planEngineering(home, cwd, stub);

    const resume = await run(['resume', '--latest-open', '--answers', await writeEgressDecline(home)]);

    await rejects(() => readFile(proofPath(home, runId), 'utf8'), 'nothing is fabricated when nothing was attested');
    const warning = (resume.report.warnings ?? []).find((w) => /no Codex \/hooks attestation has been recorded/.test(w));
    ok(warning, `the absence is stated, not silent: ${JSON.stringify(resume.report.warnings)}`);
    ok(/\/hooks/.test(warning) && /--attest-codex-hook-review/.test(warning), 'the two-step recovery is spelled out');
  });

  it('a doctor report missing the settings_runs section warns rather than silently skipping', async () => {
    const { home, cwd } = await makeHome({ satisfied: true });
    // The pre-fix world's report shape: no section at either path.
    const calls = [];
    const runner = async (scriptPath, args) => {
      calls.push({ scriptPath, args: [...args] });
      if (scriptPath.endsWith('settings.mjs')) return okOut(JSON.stringify({ plugin_management: { plan_hash: null } }));
      if (scriptPath.endsWith('doctor.mjs')) return okOut(JSON.stringify({ schema_version: 'runtime-doctor-1.0' }));
      return missing();
    };
    const { run, runId } = await planEngineering(home, cwd, { runner, calls });

    const resume = await run(['resume', '--latest-open', '--answers', await writeEgressDecline(home)]);

    await rejects(() => readFile(proofPath(home, runId), 'utf8'));
    const warning = (resume.report.warnings ?? []).find((w) => /no settings_runs\.codex_hook_review section/.test(w));
    ok(warning, `a shape regression is named, not papered over: ${JSON.stringify(resume.report.warnings)}`);
    ok(/repair or upgrade the runtime plugin/.test(warning), `and the recovery is the one that can actually work: ${warning}`);
    // Naming it beats spawning a second doctor to paper over it.
    strictEqual(calls.filter((c) => c.scriptPath.endsWith('doctor.mjs')).length, 1, 'the absence does not trigger a retry storm');
  });

  it('a doctor subprocess that cannot run is reported — the failure was silent before', async () => {
    const { home, cwd } = await makeHome({ satisfied: true });
    const calls = [];
    const runner = async (scriptPath, args) => {
      calls.push({ scriptPath, args: [...args] });
      if (scriptPath.endsWith('settings.mjs')) return okOut(JSON.stringify({ plugin_management: { plan_hash: null } }));
      return missing();
    };
    const { run } = await planEngineering(home, cwd, { runner, calls });

    const resume = await run(['resume', '--latest-open', '--answers', await writeEgressDecline(home)]);
    ok((resume.report.warnings ?? []).some((w) => /runtime:doctor could not be run for the Codex \/hooks attestation/.test(w)), `a failed fetch is stated: ${JSON.stringify(resume.report.warnings)}`);
  });

  it('the base bundle carries no Codex hook-bearing plugin, so the import is not attempted at all', async () => {
    const { home, cwd } = await makeHome({ satisfied: true });
    const stub = hookDoctorStub({ review: currentReview() });
    const run = (argv) => boot({ argv, home, cwd, runner: hostedRunner(), subprocess: stub.runner });
    await run(['plan', '--bundle', 'base', '--format', 'json']);

    const resume = await run(['resume', '--latest-open', '--answers', await writeEgressDecline(home)]);
    strictEqual(doctorCalls(stub).length, 0, 'no attestation fetch on a selection with nothing to attest');
    ok(!(resume.report.warnings ?? []).some((w) => /attestation/i.test(w)), 'and nothing to warn about');
  });
});

// ---------------------------------------------------------------------------
// §6.2 — the effective selection (declining a plugin narrows what is owed)
// ---------------------------------------------------------------------------

describe('runtime bootstrap CLI — §6.2 the effective selection', () => {
  // A machine with these plugins on BOTH hosts and nothing else. The declined
  // plugin must be genuinely absent: a decline against a step an observation
  // already satisfied is not recorded (§6.2 — an observation is not retractable),
  // so an "installed everywhere" fixture cannot exercise this path at all.
  const withoutImage = () => hostedRunner({ installed: ALL_PLUGINS.filter((n) => n !== 'image') });

  function splitHostRunner({ claude, codex }) {
    const base = hostedRunner({ installed: [] });
    return async (name, args) => {
      const key = `${name} ${args.join(' ')}`;
      if (key === 'claude plugin list') return okOut(claudePluginList(claude));
      if (key === 'codex plugin list --json') return okOut(codexPluginList(codex));
      return base(name, args);
    };
  }

  // Serves settings.mjs, the deep-peer-smoke executor, and a bare doctor report.
  const smokeDoctorStub = async (scriptPath, args) => {
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
      return okOut(JSON.stringify({}));
    }
    return missing();
  };

  const runPath = (home, runId) => join(home, '.agentic-plugins', 'runs', 'bootstrap', runId, 'run.json');
  const smokeProofPath = (home, runId) => join(home, '.agentic-plugins', 'runs', 'bootstrap', runId, 'proof', 'deep-peer-smoke.json');

  async function answersFile(home, name, rows) {
    const path = join(home, name);
    await writeFile(path, JSON.stringify(rows));
    return path;
  }

  const DECLINE_IMAGE = [
    { step_id: 'plugin.image.claude.installed', answer: 'decline' },
    { step_id: 'plugin.image.codex.installed', answer: 'decline' },
    { step_id: 'plugin.image.codex.enabled', answer: 'decline' },
  ];
  const EXECUTE_SMOKE = [
    { step_id: 'egress.configured', answer: 'decline' },
    { step_id: 'proof.deep-peer-smoke', answer: 'execute' },
  ];

  it('CONTROL — without the decline, the uninstalled plugin stales the proof forever, naming itself', async () => {
    const { home, cwd } = await makeHome({ satisfied: true });
    const run = (argv) => boot({ argv, home, cwd, runner: withoutImage(), subprocess: smokeDoctorStub });
    await run(['plan', '--bundle', 'custom', '--plugins', 'runtime,companions,image', '--format', 'json']);

    const resume = await run(['resume', '--latest-open', '--answers', await answersFile(home, 'execute-only.json', EXECUTE_SMOKE)]);
    const smoke = resume.report.completion.proofs.find((p) => p.kind === 'deep-peer-smoke');
    // This is the defect's terminal signature, and it is the CONTROL for every
    // assertion below: a selected-but-absent plugin cannot bind a version, so the
    // proof that just ran re-judges stale the instant it is written.
    strictEqual(smoke?.status, 'stale');
    ok(smoke.reasons.some((r) => /image is in the selection but the proof binds no version for it/.test(r)),
      `the reason names the plugin: ${JSON.stringify(smoke.reasons)}`);
  });

  it('declining a plugin narrows the selection to the effective custom one, and the proof goes green', async () => {
    const { home, cwd } = await makeHome({ satisfied: true });
    const run = (argv) => boot({ argv, home, cwd, runner: withoutImage(), subprocess: smokeDoctorStub });
    const plan = await run(['plan', '--bundle', 'custom', '--plugins', 'runtime,companions,image', '--format', 'json']);
    const runId = plan.report.run_id;
    deepStrictEqual(plan.report.selection.desired, ['companions', 'image', 'runtime'], 'the plan still records what was asked for');

    const resume = await run(['resume', '--latest-open', '--answers', await answersFile(home, 'decline-image.json', [...DECLINE_IMAGE, ...EXECUTE_SMOKE])]);

    strictEqual(resume.report.selection.bundle, 'custom', '§6.2 — the decline creates a new effective CUSTOM selection');
    deepStrictEqual(resume.report.selection.desired, ['companions', 'runtime']);
    ok(resume.report.selection.excluded.includes('image'), 'the refused plugin joins excluded');

    const smoke = resume.report.completion.proofs.find((p) => p.kind === 'deep-peer-smoke');
    strictEqual(smoke?.status, 'passed', `the same proof that staled in the control now stands: ${JSON.stringify(smoke?.reasons)}`);

    // The narrowing is PERSISTED — with the steps derived from it, in one mutate.
    const manifest = JSON.parse(await readFile(runPath(home, runId), 'utf8'));
    deepStrictEqual(manifest.selection.desired, ['companions', 'runtime'], 'the manifest carries the narrowed selection');
    ok(!manifest.steps.some((s) => s.id.startsWith('plugin.image.')), 'the refused plugin owes no steps at all');
    ok(manifest.history.some((h) => /selection narrowed to the effective custom selection/.test(h.reason ?? '')),
      'the run accounts for WHY the plugin stopped being expected');
    ok(manifest.choices.some((c) => c.step_id === 'plugin.image.claude.installed' && c.answer === 'decline'),
      'and the answer itself survives in the append-only ledger');

    // The recorded evidence binds exactly the retained set.
    const recorded = JSON.parse(await readFile(smokeProofPath(home, runId), 'utf8'));
    deepStrictEqual(Object.keys(recorded.bound_versions.plugins.claude).sort(), ['companions', 'runtime']);

    // And the persisted document is still a 1.2 manifest — the narrowing needed no
    // schema addition, which is what keeps an older runtime able to read this run
    // (§4.1: an unknown non-scalar key is refused at EVERY minor).
    strictEqual(manifest.schema, 'runtime-bootstrap-run-1.2');
    const validate = await makeValidator('runtime-bootstrap-run', { pluginRoot: PLUGIN_ROOT });
    deepStrictEqual(validate(manifest).errors, []);
  });

  it('the narrowing survives the next verb — status and verify do not re-widen it', async () => {
    const { home, cwd } = await makeHome({ satisfied: true });
    const run = (argv) => boot({ argv, home, cwd, runner: withoutImage(), subprocess: smokeDoctorStub });
    const plan = await run(['plan', '--bundle', 'custom', '--plugins', 'runtime,companions,image', '--format', 'json']);
    await run(['resume', '--latest-open', '--answers', await answersFile(home, 'decline-image.json', [...DECLINE_IMAGE, ...EXECUTE_SMOKE])]);

    for (const verb of ['status', 'verify']) {
      const report = (await run([verb, '--run-id', plan.report.run_id])).report;
      deepStrictEqual(report.selection.desired, ['companions', 'runtime'], `${verb} reads the narrowed selection`);
      strictEqual(report.effective_selection, undefined, `${verb} reports no divergence once the narrowing is recorded`);
      strictEqual(report.completion.proofs.find((p) => p.kind === 'deep-peer-smoke')?.status, 'passed');
    }
  });

  it('a HOST-scoped decline narrows that host only — the plugin stays in the selection', async () => {
    const { home, cwd } = await makeHome({ satisfied: true });
    const runner = splitHostRunner({
      claude: ALL_PLUGINS.filter((n) => n !== 'image'),
      codex: ALL_PLUGINS,
    });
    const run = (argv) => boot({ argv, home, cwd, runner, subprocess: smokeDoctorStub });
    const plan = await run(['plan', '--bundle', 'custom', '--plugins', 'runtime,companions,image', '--format', 'json']);

    const resume = await run(['resume', '--latest-open', '--answers', await answersFile(home, 'decline-claude-image.json', [
      { step_id: 'plugin.image.claude.installed', answer: 'decline' },
      ...EXECUTE_SMOKE,
    ])]);

    // `desired` is a flat name list, so dropping the plugin would refuse more than
    // the operator did — Codex keeps it.
    ok(resume.report.selection.desired.includes('image'), 'a partial refusal does not remove the plugin');
    const smoke = resume.report.completion.proofs.find((p) => p.kind === 'deep-peer-smoke');
    strictEqual(smoke?.status, 'passed', `the Claude-side refusal stops staling the proof: ${JSON.stringify(smoke?.reasons)}`);

    const recorded = JSON.parse(await readFile(smokeProofPath(home, plan.report.run_id), 'utf8'));
    ok(!('image' in recorded.bound_versions.plugins.claude), 'no Claude binding for the host that was refused');
    strictEqual(recorded.bound_versions.plugins.codex.image, '9.9.9', 'the retained host still binds');

    // The declined ROW is the only record of a host-scoped refusal, so it must not
    // be dropped from the expectation the way a whole-plugin decline is.
    const manifest = JSON.parse(await readFile(runPath(home, plan.report.run_id), 'utf8'));
    strictEqual(manifest.steps.find((s) => s.id === 'plugin.image.claude.installed')?.status, 'declined');
    ok(manifest.selection.desired.includes('image'), 'and the selection seat is not rewritten for it');

    // R0 must not promise a repair that cannot happen: no resume can write a
    // host-scoped refusal into a flat `desired`, so the warning says where it lives
    // instead of telling the operator to resume forever.
    const status = await run(['status', '--run-id', plan.report.run_id]);
    deepStrictEqual(status.report.effective_selection.by_host.claude.includes('image'), false);
    const warning = status.report.warnings.find((w) => /effective selection/.test(w));
    ok(/image:claude/.test(warning), `the warning names the refused host row: ${warning}`);
    ok(/no resume moves it/.test(warning), `and does not promise a resume would record it: ${warning}`);
  });

  it('a declined Codex hook plugin leaves the attestation expectation instead of making it unsatisfiable', async () => {
    const { home, cwd } = await makeHome({ satisfied: true });
    const runner = hostedRunner({ installed: ALL_PLUGINS.filter((n) => n !== 'designer') });
    const run = (argv) => boot({ argv, home, cwd, runner, subprocess: smokeDoctorStub });
    const plan = await run(['plan', '--bundle', 'custom', '--plugins', 'runtime,companions,designer', '--format', 'json']);

    // CONTROL — with `designer` selected, the non-declinable attestation step is
    // owed and open.
    const hookBefore = plan.report.steps.find((s) => s.id === 'hooks.codex.attested');
    strictEqual(hookBefore.declinable, false);
    ok(['pending', 'blocked'].includes(hookBefore.status), `owed while the hook plugin is selected: ${hookBefore.status}`);

    const resume = await run(['resume', '--latest-open', '--answers', await answersFile(home, 'decline-designer.json', [
      { step_id: 'plugin.designer.claude.installed', answer: 'decline' },
      { step_id: 'plugin.designer.codex.installed', answer: 'decline' },
      { step_id: 'plugin.designer.codex.enabled', answer: 'decline' },
      ...EXECUTE_SMOKE,
    ])]);

    ok(!resume.report.selection.desired.includes('designer'));
    strictEqual(resume.report.completion.hook_attestation.status, 'not-applicable',
      'no retained plugin bears Codex hooks, so there is nothing to attest');
    ok(!resume.report.completion.unsatisfied.includes('hooks.codex.attested'),
      'and the step no longer blocks a run on evidence that can never exist');
  });

  it('a CODEX-ONLY decline of a hook plugin retires the attestation while the plugin stays selected', async () => {
    const { home, cwd } = await makeHome({ satisfied: true });
    // Installed on Claude, absent on Codex — so the Codex row can actually be
    // declined (a satisfied observation is not retractable).
    const runner = splitHostRunner({
      claude: ALL_PLUGINS,
      codex: ALL_PLUGINS.filter((n) => n !== 'designer'),
    });
    const run = (argv) => boot({ argv, home, cwd, runner, subprocess: smokeDoctorStub });
    const plan = await run(['plan', '--bundle', 'custom', '--plugins', 'runtime,companions,designer', '--format', 'json']);
    strictEqual(plan.report.steps.find((s) => s.id === 'hooks.codex.attested').applicable !== false, true);

    const resume = await run(['resume', '--latest-open', '--answers', await answersFile(home, 'decline-designer-codex.json', [
      { step_id: 'plugin.designer.codex.installed', answer: 'decline' },
      ...EXECUTE_SMOKE,
    ])]);

    // The plugin is RETAINED — it still runs on Claude, and `desired` cannot say
    // "Claude only". But Codex bears none of its hooks, so the non-declinable
    // attestation step has nothing left to be about. Reading the plugin-level set
    // here would keep demanding an attestation for a Codex install that will never
    // happen.
    ok(resume.report.selection.desired.includes('designer'), 'the plugin stays in the selection');
    strictEqual(resume.report.completion.hook_attestation.status, 'not-applicable');
    ok(!resume.report.completion.unsatisfied.includes('hooks.codex.attested'));
  });

  it('declining a plugin re-runs the hard closure — its edge target becomes declinable', async () => {
    const { home, cwd } = await makeHome({ satisfied: true });
    const runner = hostedRunner({ installed: ['runtime', 'companions', 'attention'] });
    const run = (argv) => boot({ argv, home, cwd, runner, subprocess: smokeDoctorStub });
    const plan = await run(['plan', '--bundle', 'engineering', '--format', 'json']);

    // CONTROL — `orchestrator` hard-requires `engineer`, so engineer is protected.
    strictEqual(plan.report.steps.find((s) => s.id === 'plugin.engineer.claude.installed').declinable, false);

    const resume = await run(['resume', '--latest-open', '--answers', await answersFile(home, 'decline-orch.json', [
      { step_id: 'plugin.orchestrator.claude.installed', answer: 'decline' },
      { step_id: 'plugin.orchestrator.codex.installed', answer: 'decline' },
      { step_id: 'plugin.orchestrator.codex.enabled', answer: 'decline' },
    ])]);

    ok(!resume.report.selection.desired.includes('orchestrator'));
    strictEqual(resume.report.steps.find((s) => s.id === 'plugin.engineer.claude.installed').declinable, true,
      'with the requiring plugin gone, its target is optional again — the closure is recomputed, not frozen at plan time');
  });

  it('a LEGACY run whose declines never narrowed is judged correctly by R0 and healed by resume', async () => {
    const { home, cwd } = await makeHome({ satisfied: true });
    const run = (argv) => boot({ argv, home, cwd, runner: withoutImage(), subprocess: smokeDoctorStub });
    const plan = await run(['plan', '--bundle', 'custom', '--plugins', 'runtime,companions,image', '--format', 'json']);
    const runId = plan.report.run_id;

    // Rewind the manifest to what the pre-§6.2 runtime would have written: the
    // declines recorded on the rows, the selection untouched.
    const manifest = JSON.parse(await readFile(runPath(home, runId), 'utf8'));
    for (const step of manifest.steps) {
      if (step.id.startsWith('plugin.image.')) step.status = 'declined';
    }
    await writeFile(runPath(home, runId), `${JSON.stringify(manifest, null, 2)}\n`);

    // R0 — status cannot persist a correction, but it must not report a completion
    // computed against plugins the operator refused either. It says both things.
    const status = await run(['status', '--run-id', runId]);
    deepStrictEqual(status.report.selection.desired, ['companions', 'image', 'runtime'], 'the stored record is presented verbatim');
    deepStrictEqual(status.report.effective_selection.plugins, ['companions', 'runtime'], 'and the retained set rides alongside it');
    ok(status.report.warnings.some((w) => /effective selection \(§6\.2\)/.test(w)), 'with the divergence named');

    // M1 — resume writes the narrowing through.
    await run(['resume', '--latest-open', '--answers', await answersFile(home, 'legacy-smoke.json', EXECUTE_SMOKE)]);
    const healed = JSON.parse(await readFile(runPath(home, runId), 'utf8'));
    deepStrictEqual(healed.selection.desired, ['companions', 'runtime']);
    const after = await run(['status', '--run-id', runId]);
    strictEqual(after.report.effective_selection, undefined, 'once healed, there is no divergence left to report');
  });

  it('a legacy narrowing does not resurrect itself to block the NEXT decline it enabled', async () => {
    const { home, cwd } = await makeHome({ satisfied: true });
    const runner = hostedRunner({ installed: ['runtime', 'companions', 'attention'] });
    const run = (argv) => boot({ argv, home, cwd, runner, subprocess: smokeDoctorStub });
    const plan = await run(['plan', '--bundle', 'engineering', '--format', 'json']);
    const runId = plan.report.run_id;

    // A run recorded before the narrowing existed: `orchestrator` declined on the
    // rows, the selection untouched.
    const manifest = JSON.parse(await readFile(runPath(home, runId), 'utf8'));
    for (const step of manifest.steps) {
      if (step.id.startsWith('plugin.orchestrator.')) step.status = 'declined';
    }
    await writeFile(runPath(home, runId), `${JSON.stringify(manifest, null, 2)}\n`);

    // The reprobe drops `orchestrator`, which is what makes `engineer` declinable —
    // and drops its rows from `steps[]` with it. A gate re-deriving the retained set
    // from the STORED selection sees no orchestrator decline, resurrects the plugin,
    // and refuses the engineer decline on the strength of a hard edge from a plugin
    // the operator already removed.
    const resume = await run(['resume', '--latest-open', '--answers', await answersFile(home, 'chain.json', [
      { step_id: 'plugin.engineer.claude.installed', answer: 'decline' },
      { step_id: 'plugin.engineer.codex.installed', answer: 'decline' },
      { step_id: 'plugin.engineer.codex.enabled', answer: 'decline' },
    ])]);

    strictEqual(resume.exitCode !== EXIT.INVALID, true, `the decline the narrowing enabled is accepted: ${JSON.stringify(resume.report.diagnostics)}`);
    deepStrictEqual(resume.report.selection.desired, ['attention', 'companions', 'runtime']);
  });

  it('a hand-written decline on a MANDATORY plugin narrows nothing — two independent refusals', async () => {
    const { home, cwd } = await makeHome({ satisfied: true });
    const run = (argv) => boot({ argv, home, cwd, runner: withoutImage(), subprocess: smokeDoctorStub });
    const plan = await run(['plan', '--bundle', 'custom', '--plugins', 'runtime,companions,image', '--format', 'json']);
    const runId = plan.report.run_id;

    // The answers grammar refuses a decline against `companions` outright, so a
    // hand-edited manifest is the only way that status reaches the run at all. It
    // must still not shrink the expectation: `proof.deep-peer-smoke` is applicable
    // BECAUSE companions is mandatory (§6.2), so narrowing it away would delete the
    // one proof that the cross-host bridge works — a false pass bought by editing
    // the file the reducer is judging.
    const manifest = JSON.parse(await readFile(runPath(home, runId), 'utf8'));
    for (const step of manifest.steps) {
      if (step.id.startsWith('plugin.companions.')) step.status = 'declined';
    }
    await writeFile(runPath(home, runId), `${JSON.stringify(manifest, null, 2)}\n`);

    const resume = await run(['resume', '--latest-open', '--answers', await answersFile(home, 'noop.json', EXECUTE_SMOKE)]);
    ok(resume.report.selection.desired.includes('companions'), 'the mandatory plugin stays in the selection');
    const smoke = resume.report.completion.proofs.find((p) => p.kind === 'deep-peer-smoke');
    strictEqual(smoke?.required, true, 'and the proof it makes reachable is still owed');

    // Two independent defenses, and the FIRST one is what actually fires here: the
    // judge re-asserts a decline only where the registry says the step is declinable
    // (§6.2), so a hand-written `declined` on a non-declinable row is normalized back
    // to the observation before the narrowing ever sees it.
    const healed = JSON.parse(await readFile(runPath(home, runId), 'utf8'));
    ok(healed.steps.filter((s) => s.id.startsWith('plugin.companions.')).every((s) => s.status !== 'declined'),
      'the forged status does not survive a re-judge');
  });

  it('a hand-written decline on ONE host of a mandatory plugin does not narrow that host', async () => {
    const { home, cwd } = await makeHome({ satisfied: true });
    const run = (argv) => boot({ argv, home, cwd, runner: withoutImage(), subprocess: smokeDoctorStub });
    const plan = await run(['plan', '--bundle', 'custom', '--plugins', 'runtime,companions,image', '--format', 'json']);
    const runId = plan.report.run_id;

    // The narrow door: a single forged row. It cannot remove `companions` from the
    // selection, and it must not remove it from Claude version binding either —
    // otherwise `proof.deep-peer-smoke` reports current while the plugin that carries
    // the bridge binds no version on one side of it.
    const manifest = JSON.parse(await readFile(runPath(home, runId), 'utf8'));
    manifest.steps.find((s) => s.id === 'plugin.companions.claude.installed').status = 'declined';
    await writeFile(runPath(home, runId), `${JSON.stringify(manifest, null, 2)}\n`);

    const status = await run(['status', '--run-id', runId]);
    strictEqual(status.report.effective_selection, undefined, 'a refusal that is not honoured is not a divergence');
    const resume = await run(['resume', '--latest-open', '--answers', await answersFile(home, 'forged-host.json', EXECUTE_SMOKE)]);
    const recorded = JSON.parse(await readFile(smokeProofPath(home, runId), 'utf8'));
    strictEqual(recorded.bound_versions.plugins.claude.companions, '9.9.9', 'the mandatory plugin still binds on the refused host');
  });

  it('a SATISFIED plugin step is not narrowed away — an observation is not retractable', async () => {
    const { home, cwd } = await makeHome({ satisfied: true });
    const run = (argv) => boot({ argv, home, cwd, runner: hostedRunner(), subprocess: smokeDoctorStub });
    await run(['plan', '--bundle', 'custom', '--plugins', 'runtime,companions,image', '--format', 'json']);

    const resume = await run(['resume', '--latest-open', '--answers', await answersFile(home, 'decline-installed.json', [...DECLINE_IMAGE, ...EXECUTE_SMOKE])]);

    // The plugin is installed on both hosts, so the judge never wrote `declined`
    // (§6.2) and the selection is unchanged. The proof is green anyway — an
    // installed plugin binds a version, which is the case that was never broken.
    ok(resume.report.selection.desired.includes('image'), 'a decline does not un-observe an installed plugin');
    strictEqual(resume.report.selection.bundle, 'custom');
    strictEqual(resume.report.completion.proofs.find((p) => p.kind === 'deep-peer-smoke')?.status, 'passed');
  });
});
