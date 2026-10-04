// tests/runtime/test-bootstrap-cli.mjs
//
// machine-bootstrap-contract.md §11.2 — the PUBLIC-SURFACE half of the test
// obligations, driven through `runBootstrap` with every dependency injected
// (probe runner, subprocess runner, home, cwd, clock). The storage
// layer's obligations (#16/#28/#29/#30/#32 at the library seam) live in
// tests/runtime/test-bootstrap.mjs; this file exercises the §3 grammar, the
// R0/M1 boundary, the no-executor rule, and the CLI lifecycle end to end.

import { deepStrictEqual, match, notStrictEqual, ok, rejects, strictEqual } from 'node:assert';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  ANSWER_VALUES,
  BOOTSTRAP_REPORT_SCHEMA_VERSION,
  EXIT,
  REPORT_FINDINGS_MAX,
  STAGE0_COMMANDS,
  boundReportFindings,
  parseBootstrapArgs,
  renderText,
  runBootstrap,
} from '../../plugins/runtime/scripts/bootstrap.mjs';
import { makeValidator } from '../../plugins/runtime/scripts/lib/schema-validate.mjs';
import {
  projectModelEffort,
  readUserGlobalModelEffort,
  readUserGlobalRuntimeConfig,
} from '../../plugins/runtime/scripts/lib/profile-readers.mjs';

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
    // The canonical agentic-6 status_line: the Codex statusline step is an
    // EXACT probe, so a "satisfied" fixture carries exactly that array in ONE
    // [tui] table, matching the one table the statusline-codex fragment renders.
    ? `approval_policy = "on-request"\nsandbox_mode = "workspace-write"\n[tui]\nstatus_line = ["model-with-reasoning", "git-branch", "pull-request-number", "context-used", "five-hour-limit", "weekly-limit"]\n`
    : '# empty\n');
  await writeFile(join(home, '.agentic-plugins', 'config.local.toml'), '# local sentinel\n');
  // The Codex install caches the runners' `codex plugin list --json` describes: Codex
  // serves an installed plugin from `<cache>/<plugin>/<version>/`, so a listed install
  // with no such directory is one the probe cannot read (ADR-0061 S3 reads it
  // `unknown`). The list stays authoritative for WHICH plugins are installed.
  for (const name of ALL_PLUGINS) {
    const installed = join(home, '.codex', 'plugins', 'cache', 'agentic-plugins', name, '9.9.9', '.codex-plugin');
    await mkdir(installed, { recursive: true });
    await writeFile(join(installed, 'plugin.json'), JSON.stringify({ name, version: '9.9.9' }));
  }
  if (satisfied) {
    await writeFile(join(home, '.agentic-plugins', 'config.toml'), 'model = "gpt-5.2-codex"\neffort = "high"\n');
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

// A host runner whose answers can be rewritten between calls, so the machine
// can move WHILE the executor runs. Every field is read on each call, not
// captured once. Per-host plugin lists (`state.claude` / `state.codex`) fall
// back to the shared `state.installed`, so a test only names the axis it moves.
function mutableRunner(state) {
  const on = (host) => state[host] ?? state.installed;
  return async (name, args) => {
    const key = `${name} ${args.join(' ')}`;
    if (!state.hosts.includes(name)) return missing();
    if (key === 'claude --version') return okOut('2.1.0 (Claude Code)');
    if (key === 'claude auth status') return okOut(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' }));
    if (key === 'claude plugin list') return okOut(claudePluginList(on('claude')));
    if (key === 'claude plugin marketplace list --json') return okOut(MARKETPLACE_JSON);
    if (name === 'claude') return okOut('usage');
    if (key === 'codex --version') return okOut('codex-cli 0.140.0');
    if (key === 'codex login status') return okOut('Logged in using ChatGPT');
    if (key === 'codex plugin list --json') return okOut(codexPluginList(on('codex')));
    if (key === 'codex plugin marketplace list --json') return okOut(MARKETPLACE_JSON);
    if (name === 'codex') return okOut('usage');
    return missing();
  };
}

const satisfiedRunner = () => hostedRunner();

// The one declinable CONFIG step this fixture never satisfies from config,
// resolved the contract-shaped way — an explicit operator answer through
// --answers. `config.session` is a Stage-4 VALUE step (§6.1.3): it is satisfied
// only by a DECISION plus an observation confirming it, and a fixture that
// records no decision leaves it pending forever — which is the interview
// working, not a defect. Declining is the terse fixture answer; the value paths
// get their own tests rather than riding in every unrelated one.
async function writeSessionDecline(home) {
  const path = join(home, 'session-decline.json');
  await writeFile(path, JSON.stringify([
    { step_id: 'config.session', answer: 'decline' },
  ]));
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
      ['plan', '--out', 'x'],
      ['abandon'],
      ['profile', 'export'],
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
    // D1 §3.2 — the refusal locates the row by its position in the answers file
    // and withholds the unmatched id (it is operator-authored free text), while
    // still naming the ids this run DOES expect.
    ok(/answers\[0\] names a step this run does not expect/.test(two.report.error), two.report.error);
    ok(!two.report.error.includes('plugin.designer.claude.installed'), 'the unmatched id is not quoted back');
    ok(/expected ids: .*host\.claude\.present/.test(two.report.error), 'the expected ids are still named');
    void ANSWER_VALUES;
  });

  it('C1 — an accept/execute answer against a non-applicable step is refused, never absorbed', async () => {
    const { home, cwd } = await makeHome();
    await mkdir(join(home, 'answers'), { recursive: true });
    // `base` carries no engineer, so proof.workflow-continuation derives
    // applicable:false — the row exists in steps[] but this run does not apply
    // it. Before the one-grammar fix the answer was recorded in choices[] and
    // then shown by nothing: the §11.2 filter is `required || declined`, and
    // neither answer sets `declined`.
    for (const answer of ['accept', 'execute']) {
      const file = join(home, 'answers', `${answer}-inert.json`);
      await writeFile(file, JSON.stringify([{ step_id: 'proof.workflow-continuation', answer }]));
      const res = await boot({ argv: ['plan', '--bundle', 'base', '--answers', file], home, cwd, runner: bareRunner(), subprocess: spySubprocess().runner });
      strictEqual(res.exitCode, EXIT.INVALID, `${answer} against a non-applicable step must be refused`);
      ok(/is not applicable to this run's selection/.test(res.report.error), res.report.error);
    }
  });

  it('C1 — a decline against that SAME non-applicable step stays legal, because it is visible', async () => {
    // The counter-case, pinned so the applicability rule can never be widened
    // back over it. A decline sets `declined: true`, which the §11.2 filter
    // renders as `not-applicable (declined)`, so the refusal stays visible. The
    // first cut of this fix refused the whole status and deleted that path;
    // existing presentation cases caught it.
    const { home, cwd } = await makeHome();
    const file = join(home, 'decline-na.json');
    await writeFile(file, JSON.stringify([{ step_id: 'proof.workflow-continuation', answer: 'decline' }]));
    const res = await boot({ argv: ['plan', '--bundle', 'base', '--answers', file, '--format', 'json'], home, cwd, runner: bareRunner(), subprocess: spySubprocess().runner });
    notStrictEqual(res.exitCode, EXIT.INVALID, 'a decline is a recorded decision, not an inert one');
    const wc = res.report.completion.proofs.find((pr) => pr.kind === 'workflow-continuation');
    strictEqual(wc.declined, true, 'the refusal is recorded');
    strictEqual(wc.required, false, 'and it is still not owed');
  });

  it('C1 — execute is refused against a step no executor could ever reach', async () => {
    const { home, cwd } = await makeHome();
    const file = join(home, 'execute-config.json');
    // A CONFIG step. The resume executor only ever looked at `proof.*`, and it
    // expressed that as a silent filter, so this was accepted and dropped.
    await writeFile(file, JSON.stringify([{ step_id: 'config.model_effort', answer: 'execute' }]));
    const res = await boot({ argv: ['plan', '--bundle', 'base', '--answers', file], home, cwd, runner: bareRunner(), subprocess: spySubprocess().runner });
    strictEqual(res.exitCode, EXIT.INVALID);
    ok(/targets proof\.\* steps only/.test(res.report.error), res.report.error);
  });

  it('C1 — the executor re-asks the grammar: a proof this resume declined into non-applicability does not run', async () => {
    // The SECOND enforcement point, and the case the grammar structurally
    // cannot refuse: both answers are legal when given. Declining engineer
    // narrows the selection (§6.2), which removes the proof engineer carried —
    // so the `execute` approved a proof the run no longer applies. Observed on
    // the model/effort slice's cross-host review, where it still executed.
    const { home, cwd } = await makeHome();
    const spy = spySubprocess();
    const run = (argv) => boot({ argv, home, cwd, runner: bareRunner(), subprocess: spy.runner });
    await run(['plan', '--bundle', 'custom', '--plugins', 'runtime,companions,engineer', '--format', 'json']);
    const answers = join(home, 'decline-then-execute.json');
    await writeFile(answers, JSON.stringify([
      { step_id: 'plugin.engineer.claude.installed', answer: 'decline' },
      { step_id: 'plugin.engineer.codex.installed', answer: 'decline' },
      { step_id: 'proof.workflow-continuation', answer: 'execute' },
    ]));
    const resume = await run(['resume', '--latest-open', '--answers', answers, '--format', 'json']);
    notStrictEqual(resume.exitCode, EXIT.INVALID, 'both answers are legal at answer time');
    const warnings = resume.report.warnings ?? [];
    ok(warnings.some((w) => /no longer applies it/.test(w)), `the skip must be stated, not silent: ${JSON.stringify(warnings)}`);
    // Both halves are proven by the same mutant: deleting the skip replaces
    // this absence with `runtime:doctor --record for workflow-continuation
    // failed`, which is the executor actually reaching for the proof.
    ok(
      !warnings.some((w) => /--record for workflow-continuation/.test(w)),
      `no executor may reach a proof the run no longer applies: ${JSON.stringify(warnings)}`,
    );
  });

  it('C1 — a plan-time execute nothing will consume is refused, on EVERY proof step', async () => {
    // Measured, and it corrected this fix's own first draft: `resume` builds its
    // execute set from its OWN answers file, so a plan-time `execute` is recorded
    // and then never acted on (the bare resume left deep-peer-smoke `absent` with
    // no warning and no doctor call). ADR-0064 removed the one proof that was an
    // exception, so the refusal holds for every proof step — each asked alone, so
    // one step's refusal cannot stand in for another's. `engineering` makes all
    // three applicable, which keeps this the plan-time rule and not the
    // applicability one.
    const { home, cwd } = await makeHome();
    const run = (argv) => boot({ argv, home, cwd, runner: hostedRunner(), subprocess: spySubprocess().runner });
    for (const stepId of ['proof.deep-peer-smoke', 'proof.permission', 'proof.workflow-continuation']) {
      const file = join(home, `plan-exec-${stepId}.json`);
      await writeFile(file, JSON.stringify([{ step_id: stepId, answer: 'execute' }]));
      const refused = await run(['plan', '--bundle', 'engineering', '--answers', file]);
      strictEqual(refused.exitCode, EXIT.INVALID, `${stepId}: a plan-time execute is refused`);
      ok(/not acted on under plan/.test(refused.report.error), `${stepId}: ${refused.report.error}`);
    }
    // CONTROL: the same answers are legal on resume, so the refusal above is the
    // plan-time rule rather than a refusal of the step.
    const plan = await run(['plan', '--bundle', 'engineering', '--format', 'json']);
    notStrictEqual(plan.exitCode, EXIT.INVALID);
    const decline = join(home, 'resume-decline-permission.json');
    await writeFile(decline, JSON.stringify([{ step_id: 'proof.permission', answer: 'decline' }]));
    notStrictEqual((await run(['resume', '--latest-open', '--answers', decline])).exitCode, EXIT.INVALID);
  });

  it('ADR-0064 — the attest verb is unknown, the attest-receipt answer is refused, and a retired step id is not an expected step', async () => {
    const { home, cwd } = await makeHome();
    const run = (argv) => boot({ argv, home, cwd, runner: bareRunner(), subprocess: spySubprocess().runner });

    const attest = await run(['attest', '--latest']);
    strictEqual(attest.exitCode, EXIT.INVALID, 'attest is no longer a verb');
    match(attest.report.error, /unknown verb/);
    match(attest.report.error, /expected: plan \| status \| resume \| verify \| abandon\)/, 'the verb list no longer offers attest');

    // CONTROL: a run exists and the same resume with a legal answer is accepted,
    // so each refusal below is about the answer, not about the run.
    strictEqual((await run(['plan', '--bundle', 'base'])).exitCode, EXIT.INCOMPLETE);
    const legal = join(home, 'legal.json');
    await writeFile(legal, JSON.stringify([{ step_id: 'proof.permission', answer: 'accept' }]));
    notStrictEqual((await run(['resume', '--latest-open', '--answers', legal])).exitCode, EXIT.INVALID);

    const receipt = join(home, 'attest-receipt.json');
    await writeFile(receipt, JSON.stringify([{ step_id: 'proof.permission', answer: 'attest-receipt' }]));
    const refused = await run(['resume', '--latest-open', '--answers', receipt]);
    strictEqual(refused.exitCode, EXIT.INVALID, 'attest-receipt is not an answer any more');
    match(refused.report.error, /answers\[0\]/);

    for (const retired of ['proof.egress-provider-ack', 'egress.configured', 'config.notify_kinds', 'notify.configured', 'notify.codex.configured']) {
      const file = join(home, `retired-${retired}.json`);
      await writeFile(file, JSON.stringify([{ step_id: retired, answer: 'decline' }]));
      const res = await run(['resume', '--latest-open', '--answers', file]);
      strictEqual(res.exitCode, EXIT.INVALID, `${retired} is not a step this run expects`);
      match(res.report.error, /names a step this run does not expect/);
    }
    strictEqual((await run(['abandon', '--latest-open'])).exitCode, EXIT.OK);
  });
  it('C1 — a prior decline cannot smuggle an execute past applicability', async () => {
    // judgeSteps writes `not-applicable` and then RESTORES a prior `declined`
    // over it for any declinable step, so reading applicability off the STATUS
    // missed this entirely: doctor ran for a step the reducer simultaneously
    // reported required:false, status:not-applicable. Applicability now comes
    // from the expectation, which no status restoration can overwrite.
    const { home, cwd } = await makeHome();
    const spy = spySubprocess();
    const run = (argv) => boot({ argv, home, cwd, runner: bareRunner(), subprocess: spy.runner });
    const dec = join(home, 'decline-first.json');
    await writeFile(dec, JSON.stringify([{ step_id: 'proof.workflow-continuation', answer: 'decline' }]));
    await run(['plan', '--bundle', 'base', '--answers', dec, '--format', 'json']);
    const exec = join(home, 'execute-after.json');
    await writeFile(exec, JSON.stringify([{ step_id: 'proof.workflow-continuation', answer: 'execute' }]));
    const res = await run(['resume', '--latest-open', '--answers', exec, '--format', 'json']);
    strictEqual(res.exitCode, EXIT.INVALID, 'the restored decline must not make it executable');
    ok(/is not applicable to this run's selection/.test(res.report.error), res.report.error);
    ok(
      !(res.report.warnings ?? []).some((w) => /--record for workflow-continuation/.test(w)),
      'and no executor may have reached it',
    );
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
    const answers = await writeSessionDecline(home);
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

  it('#8 — plan + verify leave every host-config sentinel byte-identical', async () => {
    const { home, cwd } = await makeHome({ satisfied: true });
    const spy = spySubprocess({ settingsHash: 'b'.repeat(64) });
    const sentinelsBefore = await snapshotSentinels(home);
    const answers = await writeSessionDecline(home);

    const plan = await boot({ argv: ['plan', '--bundle', 'base', '--answers', answers], home, cwd, runner: satisfiedRunner(), subprocess: spy.runner });
    strictEqual(plan.exitCode, EXIT.CONFIGURED_NOT_VERIFIED);
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

  // ADR-0064 Decision 3 removed `profile seed`, the only writer of `seeded_from`,
  // without a run-schema bump: a run it seeded before the removal must still read
  // as a run. The key is injected because nothing can produce it any more.
  it('a retained run carrying seeded_from still reads, keeps the key through resume, and no new run writes it', async () => {
    const { home, cwd } = await makeHome();
    const spy = spySubprocess();
    const run = (argv) => boot({ argv, home, cwd, runner: bareRunner(), subprocess: spy.runner });

    const plan = await run(['plan', '--bundle', 'base', '--format', 'json']);
    const runPath = join(home, '.agentic-plugins', 'runs', 'bootstrap', plan.report.run_id, 'run.json');
    ok(!('seeded_from' in JSON.parse(await readFile(runPath, 'utf8'))), 'a fresh plan does not write seeded_from');
    strictEqual((await run(['resume', '--latest-open', '--format', 'json'])).exitCode, EXIT.INCOMPLETE);
    const manifest = JSON.parse(await readFile(runPath, 'utf8'));
    ok(!('seeded_from' in manifest), 'nor does a resume of an unseeded run');

    const seededFrom = { profile_id: 'laptop', profile_hash: 'a'.repeat(64) };
    await writeFile(runPath, JSON.stringify({ ...manifest, seeded_from: seededFrom }, null, 2));
    strictEqual((await run(['status', '--format', 'json'])).exitCode, EXIT.INCOMPLETE, 'status reads it as an open run');
    strictEqual((await run(['verify', '--latest', '--format', 'json'])).exitCode, EXIT.INCOMPLETE, 'and so does verify');
    // A later clock, so the stamp proves resume wrote the file rather than
    // reporting success over the injected bytes.
    const later = NOW + 60_000;
    const resumed = await boot({ argv: ['resume', '--latest-open', '--format', 'json'], home, cwd, runner: bareRunner(), subprocess: spy.runner, now: later });
    strictEqual(resumed.exitCode, EXIT.INCOMPLETE, 'resume reads it too');
    const rewritten = JSON.parse(await readFile(runPath, 'utf8'));
    strictEqual(rewritten.updated_at, new Date(later).toISOString(), 'and rewrites the manifest');
    deepStrictEqual(rewritten.seeded_from, seededFrom, 'with the linkage intact');

    // The control: the reader does validate the key, so the reads above passed
    // because seeded_from is still in the schema, not because nothing checks it.
    await writeFile(runPath, JSON.stringify({ ...manifest, seeded_from: { profile_id: 'laptop', profile_hash: 'not-a-hash' } }, null, 2));
    const refused = await run(['status', '--format', 'json']);
    strictEqual(refused.exitCode, EXIT.UNEXPECTED, 'a malformed seeded_from is refused');
    match(refused.report.diagnostics.join(' '), /\$\.seeded_from\.profile_hash/, 'and the refusal names it');

    // Restore a readable manifest so the run can be abandoned the normal way.
    await writeFile(runPath, JSON.stringify(manifest, null, 2));
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
        // ADR-0057 §Decision 5 — `proof.permission` is now ALWAYS applicable, so a run
        // that must terminalize `complete` owes it exactly as it owes the smoke.
        if (args.includes('--execute-permission-proof')) {
          return okOut(JSON.stringify({
            permission_proof: { directions: { claude_to_codex: { execution: 'executed', status: 'passed' }, codex_to_claude: { execution: 'executed', status: 'passed' } } },
            doctor_artifact: { artifact_pointer: '~/.agentic-plugins/runs/doctor/stub/artifact.json' },
          }));
        }
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
    await writeFile(answersPath, JSON.stringify([{ step_id: 'proof.deep-peer-smoke', answer: 'execute' }, { step_id: 'proof.permission', answer: 'execute' }]));
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

  it('fragment persistence COMPOSES a judge\'s recovery with the §10.3 guidance instead of replacing it (Codex review)', async () => {
    const { home, cwd } = await makeHome();
    // A statusline of the operator's own: the Claude judge names it and says
    // runtime never chains it (its observation-time recovery), and the step is
    // still unresolved, so its fragment is persisted beside that recovery.
    await writeFile(join(home, '.claude', 'settings.json'), `${JSON.stringify({ statusLine: { type: 'command', command: 'node /opt/my-own-statusline.mjs' } }, null, 2)}\n`);
    const plan = await boot({ argv: ['plan', '--bundle', 'base', '--format', 'json'], home, cwd, runner: hostedRunner(), subprocess: spySubprocess().runner });
    const manifest = JSON.parse(await readFile(join(home, '.agentic-plugins', 'runs', 'bootstrap', plan.report.run_id, 'run.json'), 'utf8'));
    const step = manifest.steps.find((s) => s.id === 'statusline.claude.configured');
    ok(!['satisfied', 'declined', 'not-applicable'].includes(step.status), `precondition: the step is unresolved (${step.status})`);
    ok(step.fragment_pointer, 'the statusline fragment was persisted for the unresolved step');
    // Both halves must survive: the judge's own recovery AND the fragment
    // backup/verify guidance.
    ok(/never auto-chains a statusline/.test(step.recovery), `the judge's recovery survives fragment persistence: ${step.recovery}`);
    ok(/Backup /.test(step.recovery), 'the §10.3 fragment guidance is appended');
  });
  // ADR-0061 S3 (Codex review round 4): Codex lists engineer installed at 9.9.9 but no
  // install-cache directory holds it. The plan names the manual reinstall beside the
  // presented executor — never folded into it, since the executor cannot repair it —
  // and the persisted manifest still validates (the state is the schema's `unknown`).
  it('presents a manual reinstall for a listed Codex install with no cache directory for its version', async () => {
    const { home, cwd } = await makeHome();
    await rm(join(home, '.codex', 'plugins', 'cache', 'agentic-plugins', 'engineer'), { recursive: true, force: true });
    const plan = await boot({ argv: ['plan', '--bundle', 'engineering', '--format', 'json'], home, cwd, runner: hostedRunner(), subprocess: spySubprocess().runner });
    strictEqual(plan.report.probe.hosts.codex.plugins.engineer.state, 'unknown');
    const manual = plan.report.plugin_management.manual_actions ?? [];
    deepStrictEqual(manual.map((action) => `${action.host}:${action.plugin}:${action.action}`), ['codex:engineer:reinstall']);
    ok(!plan.report.plugin_management.actions.some((action) => action.plugin === 'engineer'), 'not an executor candidate');
    const text = renderText({ ...plan.report, format: 'text' });
    ok(/manual \(codex\): Codex lists engineer@9\.9\.9 installed, but no install-cache directory holds that version/.test(text), text);
    const manifest = JSON.parse(await readFile(join(home, '.agentic-plugins', 'runs', 'bootstrap', plan.report.run_id, 'run.json'), 'utf8'));
    const validate = await makeValidator('runtime-bootstrap-run', { pluginRoot: PLUGIN_ROOT });
    deepStrictEqual(validate(manifest).errors, []);
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

  it('a refusal renders its reason in text, not only in JSON', async () => {
    // `reason` is set by `abandon` (and was by `profile export`), paired
    // with a `diagnostics` list that can be empty — leaving a text-mode
    // operator holding "refused" and no cause.
    const text = renderText({ verb: 'abandon', run_id: 'x', status: 'refused', reason: 'lock-lost', diagnostics: [] });
    ok(/^- reason: lock-lost$/m.test(text), `the cause reaches text mode:\n${text}`);
  });

  it('with no run at all, status / resume / verify answer no-active-run with exit 30', async () => {
    const { home, cwd } = await makeHome();
    const spy = spySubprocess();
    for (const argv of [['status'], ['resume'], ['verify']]) {
      const result = await boot({ argv, home, cwd, runner: bareRunner(), subprocess: spy.runner });
      strictEqual(result.exitCode, EXIT.NO_ACTIVE_RUN, `${argv.join(' ')} exits 30`);
    }
  });
});

// ---------------------------------------------------------------------------
// ADR-0048 §2.1 — the Codex [tui] statusline fragment and declined hand-offs
// ---------------------------------------------------------------------------

describe('bootstrap Codex statusline fragment — one [tui] table, declined hand-offs are history', () => {
  it('plan renders the Codex [tui] fragment with status_line alone, and no notification or egress fragment (ADR-0064)', async () => {
    const { home, cwd } = await makeHome();
    const plan = await boot({ argv: ['plan', '--bundle', 'base', '--format', 'json'], home, cwd, runner: hostedRunner(), subprocess: spySubprocess().runner });
    const fragmentsDir = join(home, '.agentic-plugins', 'runs', 'bootstrap', plan.report.run_id, 'fragments');
    const names = (await readdir(fragmentsDir)).sort();
    ok(names.includes('statusline-codex.fragment'), `precondition: the Codex statusline fragment rendered: ${JSON.stringify(names)}`);
    ok(!names.includes('notification-plan.fragment'), 'the notification plan is not rendered');
    ok(!names.includes('egress-launcher-plan.fragment'), 'the egress launcher plan is not rendered');
    ok(!names.some((n) => /notify/.test(n)), `no notify fragment of any name: ${JSON.stringify(names)}`);

    const fragment = JSON.parse(await readFile(join(fragmentsDir, 'statusline-codex.fragment'), 'utf8'));
    match(fragment.fragment_toml, /^\[tui\]$/m, 'one [tui] table');
    match(fragment.fragment_toml, /^status_line = \[/m, 'carrying status_line');
    ok(!/notifications/.test(fragment.fragment_toml), `and no notifications key: ${fragment.fragment_toml}`);
    ok(!plan.report.steps.some((s) => /^(notify|egress)\.|^config\.notify_kinds$|^proof\.egress-provider-ack$/.test(s.id)),
      'no retired step is derived');
  });

  it('declining the Codex statusline step withdraws its hand-off and never rewrites the frozen fragment (rounds 5-6)', async () => {
    // Decline withdraws the step's presentation fields (pointer + apply +
    // desired): a refused key is history. The frozen fragment itself is never
    // rewritten (a round-5 restore attempt opened a fragment-vs-manifest
    // commit-ordering hole; round-6 High), and the declined step's historical
    // hand-off must not render anywhere.
    const { home, cwd } = await makeHome();
    const run = (argv) => boot({ argv, home, cwd, runner: hostedRunner(), subprocess: spySubprocess().runner });

    const plan = await run(['plan', '--bundle', 'base', '--format', 'json']);
    const runId = plan.report.run_id;
    const fragmentPath = join(home, '.agentic-plugins', 'runs', 'bootstrap', runId, 'fragments', 'statusline-codex.fragment');
    ok(plan.report.steps.find((s) => s.id === 'statusline.codex.configured').fragment_pointer, 'precondition: the fragment was presented');
    const frozenBytes = await readFile(fragmentPath, 'utf8');

    const answersPath = join(home, 'decline-sl.json');
    await writeFile(answersPath, JSON.stringify([{ step_id: 'statusline.codex.configured', answer: 'decline' }]));
    const resume = await run(['resume', '--run-id', runId, '--answers', answersPath, '--format', 'json']);

    const slStep = resume.report.steps.find((s) => s.id === 'statusline.codex.configured');
    strictEqual(slStep.status, 'declined');
    strictEqual(slStep.fragment_pointer ?? null, null, 'decline withdraws the presentation pointer — a refused key is history');
    strictEqual(slStep.apply_command ?? null, null, 'decline withdraws the apply command');
    strictEqual(slStep.desired ?? null, null, 'decline withdraws the frozen plan expectation');
    strictEqual(await readFile(fragmentPath, 'utf8'), frozenBytes, 'the frozen fragment is NEVER rewritten');

    const rendered = (await run(['status', '--run-id', runId])).rendered;
    const renderedLines = rendered.split('\n');
    const declinedIdx = renderedLines.findIndex((l) => /statusline\.codex\.configured: declined/.test(l));
    ok(declinedIdx >= 0, 'the declined step still renders its status line');
    ok(!/^\s+(apply:|fragment:)/.test(renderedLines[declinedIdx + 1] ?? ''),
      `the declined step's historical hand-off must not render beneath it: next line = ${JSON.stringify(renderedLines[declinedIdx + 1])}`);
  });

  it('a canonical-LOOKING status_line under a redefined [tui] table is pending, never certified', async () => {
    // A dotted assignment implicitly creates [tui], and the later explicit header
    // redefines it — invalid TOML that Codex will not load, whose captured
    // status_line nonetheless reads exactly like the canonical array.
    const { home, cwd } = await makeHome({ satisfied: true });
    await writeFile(join(home, '.codex', 'config.toml'), [
      'approval_policy = "on-request"',
      'tui.theme = "dark"',
      '[tui]',
      'status_line = ["model-with-reasoning", "git-branch", "pull-request-number", "context-used", "five-hour-limit", "weekly-limit"]',
      '',
    ].join('\n'));
    const report = (await boot({ argv: ['plan', '--bundle', 'base', '--format', 'json'], home, cwd, runner: satisfiedRunner(), subprocess: spySubprocess().runner })).report;
    strictEqual(report.steps.find((s) => s.id === 'statusline.codex.configured').status, 'pending');
    ok(report.completion.unsatisfied.includes('statusline.codex.configured'), 'and it holds completion back');
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
    strictEqual(migrated.schema, 'runtime-bootstrap-run-1.5', 'the schema stamp is bumped explicitly (the old spread preserved 1.1)');
    const migrations = migrated.history.filter((h) => h.from === 'runtime-bootstrap-run-1.1' && h.to === 'runtime-bootstrap-run-1.5');
    strictEqual(migrations.length, 1, 'the migration is a history row, not a silent rewrite');
    match(migrations[0].reason, /and no retired step rows to drop\./, 'a run with no retired rows says so rather than naming none');
    // Registry-new steps joined the persisted run (the 1.1 world had no
    // statusline steps).
    ok(migrated.steps.some((s) => s.id === 'statusline.codex.configured'), 'the ADR-0048 §1 statusline step was injected additively');
    // The satisfied fixture carries the canonical status_line, so the injected
    // step judged satisfied on the same resume.
    strictEqual(migrated.steps.find((s) => s.id === 'statusline.codex.configured').status, 'satisfied');
  });

  // D1 (ratified 2026-08-02) — a legacy terminal run is still immutable history,
  // but what `status`/`verify` PRESENT is a projection rather than a replay. The
  // stored completion here carries a secret in each of the two maxLength-only
  // fields the schema never constrains further (`reasons[]` and
  // `artifact_pointer`), because those are precisely the fields an operator can
  // edit and the old verbatim replay published to stdout.
  const LEAK = 'Bearer sk-SECRET-legacy-abc123';
  const storedTerminalManifest = (runId) => ({
    ...legacyOpenManifest(runId),
    status: 'complete',
    completion: {
      state: 'complete',
      unsatisfied: [],
      missing_steps: [],
      proofs: [{
        kind: 'deep-peer-smoke',
        step_id: 'proof.deep-peer-smoke',
        declined: false,
        status: 'passed',
        reasons: [`peer smoke output: ${LEAK}`],
        required: true,
        artifact_pointer: `~/.agentic-plugins/runs/doctor/${LEAK.replace(/[^A-Za-z0-9._-]/g, '-')}/x.json`,
        artifact_hash: 'a'.repeat(64),
        bound_versions: null,
        ran_at: '2026-07-16T00:00:00Z',
      }],
      hook_attestation: { status: 'not-applicable', reasons: [`hook note: ${LEAK}`], attested_plugins: [], bound_versions: null, artifact_pointer: null, artifact_hash: null, attested_at: null },
    },
  });

  it('a TERMINAL legacy run is immutable history: exit 50, historical markers, a content-free completion SUMMARY, no re-certification', async () => {
    const { home, cwd } = await makeHome({ satisfied: true });
    const runId = 'bootstrap-20260716T000000Z-0aa002';
    const stored = storedTerminalManifest(runId);
    await seedManifest(home, stored);
    const before = await readFile(join(home, '.agentic-plugins', 'runs', 'bootstrap', runId, 'run.json'), 'utf8');

    for (const verb of ['status', 'verify']) {
      const result = await boot({ argv: [verb, '--run-id', runId, '--format', 'json'], home, cwd, runner: hostedRunner(), subprocess: spySubprocess().runner });
      strictEqual(result.exitCode, EXIT.LEGACY_HISTORICAL, `${verb} exits 50, never a current-completion code`);
      strictEqual(result.report.historical, true);
      strictEqual(result.report.not_recertified, true);

      // The raw stored object is GONE from the report — not emptied, not
      // filtered, absent. A consumer must not be able to read a disclosable
      // summary as if it were the record.
      ok(!('completion' in result.report), `${verb} emits no raw completion key`);

      const summary = result.report.legacy_completion_summary;
      strictEqual(summary.state, 'complete', 'the clamped state enum crosses');
      strictEqual(summary.proofs.length, 1);
      deepStrictEqual(summary.proofs[0], {
        kind: 'deep-peer-smoke',
        status: 'passed',
        required: true,
        declined: false,
        step_id: 'proof.deep-peer-smoke',
        artifact_hash: 'a'.repeat(64),
        ran_at: '2026-07-16T00:00:00Z',
        reason_count: 1,
      }, 'grammar-clamped proof fields cross; the free reasons leave as a count');
      strictEqual(summary.hook_attestation.reason_count, 1, 'the attestation reason is counted, never quoted');
      strictEqual(summary.source.json_pointer, '/completion');
      strictEqual(summary.source.artifact_pointer, `~/.agentic-plugins/runs/bootstrap/${runId}/run.json`,
        'the pointer is runtime-derived from the run id, not the stored artifact_pointer string');

      ok(!JSON.stringify(result.report).includes('SECRET'),
        `${verb} --format json must not carry either free-text field: ${JSON.stringify(result.report).match(/.{0,80}SECRET.{0,80}/)?.[0]}`);
    }

    const text = await boot({ argv: ['status', '--run-id', runId], home, cwd, runner: hostedRunner(), subprocess: spySubprocess().runner });
    ok(/HISTORICAL/.test(text.rendered), 'the text render carries the historical marker');
    ok(!text.rendered.includes('SECRET'), 'the text render withholds the same fields the JSON does');
    // The 64-hex artifact hash is grammar-clamped (`^[0-9a-f]{64}$`) and MUST
    // survive. This is the anti-regression for the sink sanitizer that was
    // withdrawn from this codebase for eating exactly such a hash.
    ok(text.rendered.includes('proof.deep-peer-smoke: passed'), 'the clamped verdict still renders');
    ok(/1 reason\(s\) withheld/.test(text.rendered), 'the withholding is stated, not silent');

    const after = await readFile(join(home, '.agentic-plugins', 'runs', 'bootstrap', runId, 'run.json'), 'utf8');
    strictEqual(after, before, 'the terminal record is byte-identical — nothing re-certified or rewritten');
  });

  it('the historical summary is the SAME projection in both formats — text cannot carry a field json omits', async () => {
    const { home, cwd } = await makeHome({ satisfied: true });
    const runId = 'bootstrap-20260716T000000Z-0aa004';
    await seedManifest(home, storedTerminalManifest(runId));
    const args = ['status', '--run-id', runId];
    const json = await boot({ argv: [...args, '--format', 'json'], home, cwd, runner: hostedRunner(), subprocess: spySubprocess().runner });
    const text = await boot({ argv: args, home, cwd, runner: hostedRunner(), subprocess: spySubprocess().runner });
    // Both renderings are built from one object upstream of the format branch,
    // so the field SET is identical by construction — assert the report objects
    // themselves match rather than diffing two strings.
    deepStrictEqual(text.report.legacy_completion_summary, json.report.legacy_completion_summary,
      'one projection feeds both renderings');
    strictEqual(text.report.legacy_completion_summary.proofs[0].reason_count,
      json.report.legacy_completion_summary.proofs[0].reason_count);
  });

  it('a FUTURE-minor run refuses the M1 resume — this runtime must not persist a document it half-understands', async () => {
    const { home, cwd } = await makeHome({ satisfied: true });
    const runId = 'bootstrap-20260716T000000Z-0aa003';
    await seedManifest(home, { ...legacyOpenManifest(runId), schema: 'runtime-bootstrap-run-1.9' });

    const resume = await boot({ argv: ['resume', '--run-id', runId], home, cwd, runner: hostedRunner(), subprocess: spySubprocess().runner });
    strictEqual(resume.exitCode, EXIT.INVALID);
    ok(/newer than this runtime/.test(resume.report.diagnostics.join(' ')), 'the refusal names the version relation');
  });

  // ADR-0064 Decision 7 — "Retained and open bootstrap runs". The retired ids,
  // listed here rather than read from the registry, so the test states what
  // ADR-0064 retired instead of following whatever the code now says.
  const ADR0064_RETIRED = ['config.notify_kinds', 'egress.configured', 'notify.codex.configured', 'notify.configured', 'proof.egress-provider-ack'];
  const SHA_A = 'a'.repeat(64);
  const SHA_B = 'b'.repeat(64);
  const retiredAckRecord = () => ({
    kind: 'egress-provider-ack',
    status: 'passed',
    provider_ack: { result: 'acked', attempt_hash: SHA_A, activation_fingerprint: 'c'.repeat(64), ran_at: '2026-09-20T00:00:00.000Z' },
    mirror_correlated: true,
    artifact_pointer: '~/.agentic-plugins/runs/doctor/doctor-20260920T000000Z-abc123/doctor.json',
    artifact_hash: SHA_B,
    bound_versions: { runtime: '0.90.0', claude: '2.1.0', codex: '0.140.0', plugins: { claude: {}, codex: {} } },
    ran_at: '2026-09-20T00:00:00.000Z',
  });
  const retiredReceiptRecord = () => ({ surface: 'owner-phone', attested_at: '2026-09-20T00:05:00.000Z', attempt_hash: SHA_A, provider_proof_artifact_hash: SHA_B });

  it('an OPEN 1.4 run holding retired rows migrates on resume: rows dropped and named, ledger and linkage kept, retired evidence skipped (ADR-0064 Decision 7)', async () => {
    const { home, cwd } = await makeHome({ satisfied: true });
    const runId = 'bootstrap-20260920T000000Z-0cc001';
    const at = '2026-09-20T00:00:00Z';
    const seeded = {
      ...legacyOpenManifest(runId),
      schema: 'runtime-bootstrap-run-1.4',
      started_at: at,
      updated_at: at,
      steps: [
        { id: 'config.notify_kinds', stage: 4, status: 'pending', declinable: true, blocked_by: [] },
        { id: 'notify.configured', stage: 5, status: 'satisfied', declinable: true, blocked_by: [], observed: 'notify_channel=telegram' },
        { id: 'notify.codex.configured', stage: 5, status: 'pending', declinable: true, blocked_by: ['host.codex.present'] },
        { id: 'egress.configured', stage: 5, status: 'satisfied', declinable: true, blocked_by: [] },
        { id: 'proof.egress-provider-ack', stage: 8, status: 'pending', declinable: true, blocked_by: ['egress.configured'] },
      ],
      choices: [
        { step_id: 'config.notify_kinds', answer: 'set:notify_kinds=approval,idle', at },
        { step_id: 'proof.egress-provider-ack', answer: 'execute', at },
      ],
      history: [
        { step_id: 'egress.configured', from: 'pending', to: 'satisfied', reason: 'observed on resume', at },
      ],
      seeded_from: { profile_id: 'laptop', profile_hash: SHA_A },
    };
    const runDir = await seedManifest(home, seeded);
    // PRE-CONTROL: the 1.5 schema still accepts every retired member, or the
    // run could only be abandoned (Decision 7, first bullet).
    const validate = await makeValidator('runtime-bootstrap-run', { pluginRoot: PLUGIN_ROOT });
    deepStrictEqual(validate(seeded).errors, [], 'the retained 1.4 manifest validates under the packaged schema');
    await mkdir(join(runDir, 'proof'), { recursive: true });
    const ackPath = join(runDir, 'proof', 'egress-provider-ack.json');
    const receiptPath = join(runDir, 'proof', 'egress-receipt-attestation.json');
    await writeFile(ackPath, `${JSON.stringify(retiredAckRecord(), null, 2)}\n`);
    await writeFile(receiptPath, `${JSON.stringify(retiredReceiptRecord(), null, 2)}\n`);
    const ackBefore = await readFile(ackPath);
    const receiptBefore = await readFile(receiptPath);

    const resume = await boot({ argv: ['resume', '--latest-open', '--format', 'json'], home, cwd, runner: hostedRunner(), subprocess: spySubprocess().runner });
    notStrictEqual(resume.report.status, 'evidence-unreadable', `the retired evidence files are skipped, not refused: ${JSON.stringify(resume.report.diagnostics)}`);
    ok([EXIT.INCOMPLETE, EXIT.CONFIGURED_NOT_VERIFIED].includes(resume.exitCode), `resume succeeds (exit ${resume.exitCode}): ${JSON.stringify(resume.report.diagnostics ?? [])}`);

    const migrated = JSON.parse(await readFile(join(runDir, 'run.json'), 'utf8'));
    strictEqual(migrated.schema, 'runtime-bootstrap-run-1.5', 'the run is stamped with the current minor');
    deepStrictEqual(migrated.steps.filter((step) => ADR0064_RETIRED.includes(step.id)).map((step) => step.id), [], 'no retired row survives in steps[]');
    deepStrictEqual(resume.report.steps.filter((step) => ADR0064_RETIRED.includes(step.id)).map((step) => step.id), [], 'nor in the reported steps');

    const migrations = migrated.history.filter((h) => h.step_id === null && h.from === 'runtime-bootstrap-run-1.4' && h.to === 'runtime-bootstrap-run-1.5');
    strictEqual(migrations.length, 1, `exactly one migration row: ${JSON.stringify(migrated.history)}`);
    for (const id of ADR0064_RETIRED) {
      ok(migrations[0].reason.includes(`${id} (ADR-0064)`), `the migration row names ${id} with the ADR that retired it: ${migrations[0].reason}`);
    }
    ok(!/permission\.(claude|codex)\.applied/.test(migrations[0].reason), 'and names no retired id the run did not carry');

    deepStrictEqual(migrated.choices.slice(0, seeded.choices.length), seeded.choices, 'choices[] keeps every row as written, retired ids included');
    deepStrictEqual(migrated.history.slice(0, seeded.history.length), seeded.history, 'history[] keeps every earlier row as written');
    deepStrictEqual(migrated.seeded_from, seeded.seeded_from, 'seeded_from stays as written');
    deepStrictEqual(validate(migrated).errors, [], 'the migrated manifest validates');

    ok((await readFile(ackPath)).equals(ackBefore), 'the retired ack file stays on disk byte-identical');
    ok((await readFile(receiptPath)).equals(receiptBefore), 'the retired receipt file stays on disk byte-identical');

    for (const completion of [resume.report.completion, migrated.completion]) {
      ok(!completion.proofs.some((p) => p.kind === 'egress-provider-ack'), `no egress-provider-ack proof is reduced: ${JSON.stringify(completion.proofs.map((p) => p.kind))}`);
      ok(!('egress_receipt_attestation' in completion), 'and no receipt verdict is written');
    }

    // The migrated run is a 1.5 run now, so status reads its proof directory —
    // the skip is not limited to open runs of an earlier minor.
    const status = await boot({ argv: ['status', '--run-id', runId, '--format', 'json'], home, cwd, runner: hostedRunner(), subprocess: spySubprocess().runner });
    notStrictEqual(status.report.status, 'evidence-unreadable', JSON.stringify(status.report.diagnostics));
    notStrictEqual(status.exitCode, EXIT.UNEXPECTED);
    strictEqual(status.report.historical, undefined, 'a 1.5 run takes the current path, not the historical one');
    ok(!status.report.completion.proofs.some((p) => p.kind === 'egress-provider-ack'));
  });

  it('a TERMINAL 1.4 run keeps its stored egress proof and receipt verdict as history, and its proof files are not read (ADR-0064 Decision 7)', async () => {
    const { home, cwd } = await makeHome({ satisfied: true });
    const runId = 'bootstrap-20260920T000000Z-0cc002';
    const stored = {
      ...legacyOpenManifest(runId),
      schema: 'runtime-bootstrap-run-1.4',
      status: 'complete',
      steps: [
        { id: 'egress.configured', stage: 5, status: 'satisfied', declinable: true, blocked_by: [] },
        { id: 'proof.egress-provider-ack', stage: 8, status: 'satisfied', declinable: true, blocked_by: ['egress.configured'] },
      ],
      completion: {
        state: 'complete',
        unsatisfied: [],
        missing_steps: [],
        proofs: [
          { kind: 'deep-peer-smoke', step_id: 'proof.deep-peer-smoke', declined: false, status: 'passed', reasons: [], required: true, artifact_pointer: null, artifact_hash: SHA_A, bound_versions: null, ran_at: '2026-09-20T00:00:00Z' },
          { kind: 'egress-provider-ack', step_id: 'proof.egress-provider-ack', declined: false, status: 'passed', reasons: ['acked and mirrored'], required: true, artifact_pointer: null, artifact_hash: SHA_B, bound_versions: null, ran_at: '2026-09-20T00:00:00Z' },
        ],
        hook_attestation: { status: 'not-applicable', reasons: [], attested_plugins: [], bound_versions: null, artifact_pointer: null, artifact_hash: null, attested_at: null },
        egress_receipt_attestation: { status: 'attested', reasons: [], attested_at: '2026-09-20T00:05:00Z', attempt_hash: SHA_A, provider_proof_artifact_hash: SHA_B },
      },
    };
    const runDir = await seedManifest(home, stored);
    const before = await readFile(join(runDir, 'run.json'), 'utf8');
    const reportOf = async (verb) => boot({ argv: [verb, '--run-id', runId, '--format', 'json'], home, cwd, runner: hostedRunner(), subprocess: spySubprocess().runner });

    const clean = {};
    for (const verb of ['status', 'verify']) {
      const result = await reportOf(verb);
      clean[verb] = result.report;
      strictEqual(result.exitCode, EXIT.LEGACY_HISTORICAL, `${verb} exits 50`);
      strictEqual(result.report.historical, true);
      strictEqual(result.report.legacy_schema, 'runtime-bootstrap-run-1.4');
      const summary = result.report.legacy_completion_summary;
      deepStrictEqual(summary.proofs.find((p) => p.kind === 'egress-provider-ack'), {
        kind: 'egress-provider-ack',
        status: 'passed',
        required: true,
        declined: false,
        step_id: 'proof.egress-provider-ack',
        artifact_hash: SHA_B,
        ran_at: '2026-09-20T00:00:00Z',
        reason_count: 1,
      }, `${verb}: the stored egress row is projected, not dropped`);
      strictEqual(summary.proofs.length, 2, 'both stored rows are projected');
      strictEqual(summary.unreadable_proof_records, 0, `${verb}: the retired kind is not counted unreadable`);
      ok(summary.egress_receipt_attestation, `${verb}: the stored receipt verdict is summarized`);
      strictEqual(summary.egress_receipt_attestation.status, 'attested');
    }

    const text = (await boot({ argv: ['status', '--run-id', runId], home, cwd, runner: hostedRunner(), subprocess: spySubprocess().runner })).rendered;
    ok(/^ {2}- receipt attestation: attested$/m.test(text), `the historical render keeps the receipt line:\n${text}`);
    ok(/^ {2}- \[stage 8\] proof\.egress-provider-ack: passed; 1 reason\(s\) withheld$/m.test(text), `and the egress row:\n${text}`);
    ok(!/proof record\(s\) carried no recognizable kind/.test(text), 'nothing is reported unreadable');

    // Its proof files are not read: an invalid retired file AND an invalid
    // live-kind file change nothing. The live-kind one is the discriminator — the
    // reader skips a retired file by name on every path, but it refuses an
    // unparseable deep-peer-smoke.json on any path that reads the directory.
    await mkdir(join(runDir, 'proof'), { recursive: true });
    await writeFile(join(runDir, 'proof', 'egress-provider-ack.json'), 'not json {');
    await writeFile(join(runDir, 'proof', 'deep-peer-smoke.json'), 'not json {');
    for (const verb of ['status', 'verify']) {
      const result = await reportOf(verb);
      strictEqual(result.exitCode, EXIT.LEGACY_HISTORICAL, `${verb} still exits 50`);
      deepStrictEqual(result.report, clean[verb], `${verb}: the outcome does not depend on the run's proof files`);
    }
    strictEqual(await readFile(join(runDir, 'run.json'), 'utf8'), before, 'the terminal record is byte-identical');
  });
});

function renderOf(result) {
  return result.rendered ?? '';
}

// ---------------------------------------------------------------------------
// resume's ONE final snapshot
//
// The defect these pin: resume re-probed after an executor and then reduced +
// persisted against that fresh probe while the STEPS inside the same manifest,
// Stage 0, and the returned report all still derived from the pre-execution
// one. The run therefore stored a probe its own steps had never been judged
// against, and handed the caller a third, older view of the machine.
//
// Every test here changes the machine DURING the executor — the only window in
// which the two snapshots can differ — and then asserts the run speaks about
// one machine. Each was mutation-verified: reverting the reconstruction fails
// it, and the pre-execution control assertion proves the fixture is not
// vacuously in the post-execution state to begin with.
// ---------------------------------------------------------------------------
describe('bootstrap resume — one final snapshot (probe, raw, readers)', () => {
  const SMOKE_SECTION = {
    deep_peer_smoke: {
      directions: {
        claude_to_codex: { execution: 'executed', status: 'passed' },
        codex_to_claude: { execution: 'executed', status: 'passed' },
      },
    },
    doctor_artifact: { artifact_pointer: '~/.agentic-plugins/runs/doctor/stub/doctor.json' },
  };


  // Executes deep-peer-smoke; `duringProof` is the machine moving underneath.
  // `stdout` lets a test make the executor FAIL (invalid JSON) while still
  // having spawned the child — the distinction the snapshot trigger turns on.
  function smokeDoctorStub(duringProof, { stdout = JSON.stringify(SMOKE_SECTION) } = {}) {
    return async (scriptPath, args) => {
      if (scriptPath.endsWith('settings.mjs')) return okOut(JSON.stringify({ plugin_management: { plan_hash: null } }));
      if (scriptPath.endsWith('doctor.mjs')) {
        // ADR-0057 §Decision 5 — `proof.permission` is now ALWAYS applicable, so a run
        // that must terminalize `complete` owes it exactly as it owes the smoke.
        if (args.includes('--execute-permission-proof')) {
          return okOut(JSON.stringify({
            permission_proof: { directions: { claude_to_codex: { execution: 'executed', status: 'passed' }, codex_to_claude: { execution: 'executed', status: 'passed' } } },
            doctor_artifact: { artifact_pointer: '~/.agentic-plugins/runs/doctor/stub/artifact.json' },
          }));
        }
        if (args.includes('--execute-deep-peer-smoke')) {
          await duringProof();
          return okOut(stdout);
        }
        return okOut(JSON.stringify({}));
      }
      return missing();
    };
  }

  async function writeSmokeAnswers(home) {
    const path = join(home, 'execute-smoke-and-decline-session.json');
    await writeFile(path, JSON.stringify([
      { step_id: 'proof.deep-peer-smoke', answer: 'execute' },
      { step_id: 'proof.permission', answer: 'execute' },
      { step_id: 'config.session', answer: 'decline' },
    ]));
    return path;
  }

  const manifestOf = async (home, runId) =>
    JSON.parse(await readFile(join(home, '.agentic-plugins', 'runs', 'bootstrap', runId, 'run.json'), 'utf8'));

  it('a plugin that disappears DURING the proof is re-judged: the manifest never stores a probe its own steps contradict', async () => {
    const { home, cwd } = await makeHome({ satisfied: true });
    const state = { installed: [...ALL_PLUGINS], hosts: ['claude', 'codex'] };
    const run = (argv, subprocess) => boot({ argv, home, cwd, runner: mutableRunner(state), subprocess });

    const plan = await run(['plan', '--bundle', 'base', '--format', 'json'], spySubprocess().runner);
    const runId = plan.report.run_id;
    // CONTROL: the fixture starts in the state the assertion must NOT trivially
    // hold in — attention is installed and judged satisfied before the proof.
    strictEqual(plan.report.steps.find((s) => s.id === 'plugin.attention.claude.installed')?.status, 'satisfied',
      'precondition: attention is installed and satisfied at plan time');

    // The operator uninstalls a selected plugin while the smoke proof runs.
    const resume = await run(
      ['resume', '--latest-open', '--answers', await writeSmokeAnswers(home)],
      smokeDoctorStub(async () => { state.installed = ALL_PLUGINS.filter((p) => p !== 'attention'); }),
    );

    const manifest = await manifestOf(home, runId);
    strictEqual(manifest.probe.hosts.claude.plugins.attention.state, 'missing',
      'the persisted probe is the POST-execution one (this is the half that already worked)');
    const persistedRow = manifest.steps.find((s) => s.id === 'plugin.attention.claude.installed');
    strictEqual(persistedRow?.status, 'pending',
      `the step PERSISTED beside that probe was judged from it, not from the pre-execution one (got ${persistedRow?.status}: ${JSON.stringify(persistedRow)})`);
    const reportedRow = resume.report.steps.find((s) => s.id === 'plugin.attention.claude.installed');
    strictEqual(reportedRow?.status, 'pending', 'and the caller is told the same thing the manifest records');
  });

  it('the returned report carries the probe it was judged and reduced against — and a Stage 0 built from the same raw facts', async () => {
    const { home, cwd } = await makeHome({ satisfied: true });
    const state = { installed: [...ALL_PLUGINS], hosts: ['claude', 'codex'] };
    const run = (argv, subprocess) => boot({ argv, home, cwd, runner: mutableRunner(state), subprocess });

    const plan = await run(['plan', '--bundle', 'base', '--format', 'json'], spySubprocess().runner);
    const runId = plan.report.run_id;
    // CONTROL: Stage 0 is quiet while both CLIs answer — so a raised codex row
    // below can only come from the mid-proof disappearance.
    deepStrictEqual(plan.report.stage0, {}, 'precondition: Stage 0 raises nothing on a fully hosted machine');

    // The codex CLI goes away mid-proof: `raw.codex.status` is the ONLY source
    // for the Stage-0 verdict, so a Stage 0 built from the stale `raw` stays
    // silent about a host that is no longer there.
    const resume = await run(
      ['resume', '--latest-open', '--answers', await writeSmokeAnswers(home)],
      smokeDoctorStub(async () => { state.hosts = ['claude']; }),
    );

    const manifest = await manifestOf(home, runId);
    deepStrictEqual(resume.report.probe, manifest.probe,
      'the reported probe IS the persisted one — the recorded symptom was these two disagreeing');
    strictEqual(resume.report.stage0.codex?.needed, true,
      `Stage 0 is built from the final raw facts, so the vanished host is surfaced (got ${JSON.stringify(resume.report.stage0)})`);
    // `raw` is a judgement input in its own right — host presence reads it and
    // nothing else — so the reconstruction has to carry the final RAW, not just
    // re-serialize the final probe.
    strictEqual(resume.report.steps.find((s) => s.id === 'host.codex.present')?.status, 'pending',
      'the step that reads raw host status is judged from the final raw too');
  });

  // The SELECTION is an expectation input too, and the final judge can move it:
  // §6.2 lets a satisfying observation clear a `declined` row, and a declined row
  // is the only evidence effectiveSelection reads. The two tests below are a pair
  // — the first pins the defect, the second pins the over-correction that the
  // first fix attempt caused — and neither is meaningful without the other.
  async function planDesignerCustom(home, cwd, state) {
    const run = (argv, subprocess) => boot({ argv, home, cwd, runner: mutableRunner(state), subprocess });
    const plan = await run(['plan', '--bundle', 'custom', '--plugins', 'runtime,companions,designer', '--format', 'json'], spySubprocess().runner);
    return { run, plan, runId: plan.report.run_id };
  }

  it('a HOST-SCOPED decline the machine contradicts mid-proof re-derives the selection — the run never closes as complete on an exclusion its own rows dropped', async () => {
    const { home, cwd } = await makeHome({ satisfied: true });
    // designer is present on Claude, absent on Codex — so the operator can refuse
    // it on Codex alone, which is the shape the registry deliberately keeps as a
    // step ROW (selection.desired is a flat name list and cannot express it).
    const state = {
      hosts: ['claude', 'codex'],
      claude: [...ALL_PLUGINS],
      codex: ALL_PLUGINS.filter((p) => p !== 'designer'),
    };
    const { run, plan, runId } = await planDesignerCustom(home, cwd, state);
    strictEqual(plan.report.steps.find((s) => s.id === 'plugin.designer.codex.installed')?.status, 'pending',
      'precondition: the Codex row is open, so declining it is a real refusal rather than a no-op');

    const answersPath = join(home, 'decline-codex-designer.json');
    await writeFile(answersPath, JSON.stringify([
      { step_id: 'plugin.designer.codex.installed', answer: 'decline' },
      { step_id: 'plugin.designer.codex.enabled', answer: 'decline' },
      { step_id: 'config.session', answer: 'decline' },
      { step_id: 'proof.deep-peer-smoke', answer: 'execute' },
      { step_id: 'proof.permission', answer: 'execute' },
    ]));
    // The operator changes their mind and installs it on Codex mid-proof.
    const resume = await run(['resume', '--latest-open', '--answers', answersPath],
      smokeDoctorStub(async () => { state.codex = [...state.codex, 'designer']; }));

    const manifest = await manifestOf(home, runId);
    notStrictEqual(manifest.status, 'complete',
      'a run whose own rows no longer support the exclusion it bound and reduced against must not terminalize');
    ok((resume.report.warnings ?? []).some((w) => /designer/.test(w) && /codex/.test(w) && /re-derived/.test(w)),
      `the operator is told which plugin and host moved: ${JSON.stringify(resume.report.warnings)}`);

    // The load-bearing assertion: the verb's own account agrees with an
    // INDEPENDENT re-read of the same run. Before the convergence, resume
    // reported `complete` (exit 0) and the very next status reported
    // `incomplete` (exit 20) — over a terminal run resume then refuses.
    const status = await run(['status', '--format', 'json'], spySubprocess().runner);
    strictEqual(resume.report.completion?.state, status.report.completion?.state,
      `resume and an immediate status must describe one machine (resume=${resume.report.completion?.state}, status=${status.report.completion?.state})`);
    strictEqual(resume.report.steps.find((s) => s.id === 'hooks.codex.attested')?.status,
      status.report.steps.find((s) => s.id === 'hooks.codex.attested')?.status,
      'including the steps the restored host-scoped selection brings back into the expectation');
  });

  it('a FULLY refused plugin installed mid-proof stays refused — narrowing is not reversible in-run (§7)', async () => {
    // The over-correction guard. A convergence derived from the run's ORIGINAL
    // desired reads the ABSENCE of the declined rows — absent because the
    // narrowing already removed them from the expectation — as "nothing was
    // refused", and resurrects every fully-declined plugin on every resume. The
    // derivation must start from the RETAINED set, exactly as the pre-execution
    // narrowing does, so a narrowing cannot erase its own evidence.
    const { home, cwd } = await makeHome({ satisfied: true });
    const state = { hosts: ['claude', 'codex'], installed: ALL_PLUGINS.filter((p) => p !== 'designer') };
    const { run, plan, runId } = await planDesignerCustom(home, cwd, state);
    strictEqual(plan.report.steps.find((s) => s.id === 'plugin.designer.claude.installed')?.status, 'pending',
      'precondition: designer is absent on both hosts, so a decline on both fully refuses it');

    const answersPath = join(home, 'decline-designer-everywhere.json');
    await writeFile(answersPath, JSON.stringify([
      { step_id: 'plugin.designer.claude.installed', answer: 'decline' },
      { step_id: 'plugin.designer.codex.installed', answer: 'decline' },
      { step_id: 'plugin.designer.codex.enabled', answer: 'decline' },
      { step_id: 'config.session', answer: 'decline' },
      { step_id: 'proof.deep-peer-smoke', answer: 'execute' },
      { step_id: 'proof.permission', answer: 'execute' },
    ]));
    const resume = await run(['resume', '--latest-open', '--answers', answersPath],
      smokeDoctorStub(async () => { state.installed = [...ALL_PLUGINS]; }));

    const manifest = await manifestOf(home, runId);
    ok(!manifest.selection.desired.includes('designer'),
      `the operator's full refusal stands: ${JSON.stringify(manifest.selection.desired)}`);
    strictEqual(manifest.steps.find((s) => s.id === 'plugin.designer.claude.installed'), undefined,
      'a refused plugin has no rows in the expectation, and a mid-proof install does not put them back');
    ok(!(resume.report.warnings ?? []).some((w) => /designer/.test(w)),
      `and nothing is reported as re-derived: ${JSON.stringify(resume.report.warnings)}`);
    strictEqual(manifest.status, 'complete', 'the run still completes on the narrowed selection it was reduced against');
  });

  it('a selection that widens mid-proof re-derives the HOOK VERDICT with it — an attestation scoped to the narrow set cannot satisfy the wider one', async () => {
    // The verdict is selection-scoped (`codexHookBearingPlugins(…, effective.byHost.codex)`),
    // so converging the selection without recomputing it leaves a claim that was
    // true of the NARROW set standing over the wider one — and
    // `hooks.codex.attested` is non-declinable, so that is a false pass on a step
    // nothing else can clear.
    const { home, cwd } = await makeHome({ satisfied: true });
    const state = {
      hosts: ['claude', 'codex'],
      claude: [...ALL_PLUGINS],
      codex: ALL_PLUGINS.filter((p) => p !== 'designer'),
    };
    const run = (argv, subprocess) => boot({ argv, home, cwd, runner: mutableRunner(state), subprocess });
    // engineer is hook-bearing on Codex and stays selected; designer is
    // hook-bearing too and is the plugin the decline excludes.
    const plan = await run(['plan', '--bundle', 'custom', '--plugins', 'runtime,companions,engineer,designer', '--format', 'json'], spySubprocess().runner);
    const runId = plan.report.run_id;

    // An attestation that covers EXACTLY the narrowed Codex hook set.
    const attestationForEngineerOnly = {
      run_id: 'settings-20260718T030000Z-aa11bb',
      mode: 'attest-codex-hook-review',
      requested: true,
      attested: true,
      status: 'attested',
      host: 'codex',
      attested_at: '2026-07-18T03:00:00Z',
      bundled_plugins: ['engineer'],
      attested_plugins: ['engineer'],
      plugin_versions: { engineer: '9.9.9' },
      bound_versions: { codex: '0.140.0', plugins: { codex: { engineer: '9.9.9' } } },
      artifact_pointer: '~/.agentic-plugins/runs/settings/settings-20260718T030000Z-aa11bb/settings.json',
      artifact_hash: 'b'.repeat(64),
    };
    const executorStdout = JSON.stringify({
      schema_version: 'runtime-doctor-1.0',
      settings_runs: {
        status: 'ok',
        count: 1,
        malformed: 0,
        codex_hook_review: { status: 'attested', current: true, currency_reason: null, latest: attestationForEngineerOnly },
      },
      ...SMOKE_SECTION,
    });

    const answersPath = join(home, 'decline-designer-codex-with-attestation.json');
    await writeFile(answersPath, JSON.stringify([
      { step_id: 'plugin.designer.codex.installed', answer: 'decline' },
      { step_id: 'plugin.designer.codex.enabled', answer: 'decline' },
      { step_id: 'config.session', answer: 'decline' },
      { step_id: 'proof.deep-peer-smoke', answer: 'execute' },
    ]));
    const resume = await run(['resume', '--latest-open', '--answers', answersPath],
      smokeDoctorStub(async () => { state.codex = [...state.codex, 'designer']; }, { stdout: executorStdout }));

    // CONTROL: the claim really did import, so the verdict this test is about is
    // computed from a present record rather than from nothing.
    const recorded = JSON.parse(await readFile(join(home, '.agentic-plugins', 'runs', 'bootstrap', runId, 'proof', 'hook-attestation.json'), 'utf8'));
    deepStrictEqual(recorded.attested_plugins, ['engineer'], 'precondition: the imported claim covers only the narrowed Codex hook set');

    const hookRow = resume.report.steps.find((s) => s.id === 'hooks.codex.attested');
    strictEqual(hookRow?.status, 'pending',
      `designer is back in the Codex selection and the claim does not cover it, so the step stays open (got ${hookRow?.status})`);
    const persisted = (await manifestOf(home, runId)).steps.find((s) => s.id === 'hooks.codex.attested');
    strictEqual(persisted?.status, 'pending', 'and the run persists that, rather than a satisfied step nothing attested');
  });

  it('the READ-ONLY verbs converge the selection too — a completed run whose refused plugin appears later stops reading complete', async () => {
    // The worse half of the same defect, and the reason §7 can say "every verb".
    // status/verify derive `effective` from the STORED rows and then re-judge
    // them, so a host-scoped decline a later observation clears leaves the rows
    // saying `satisfied` beside a selection that still excludes the plugin. They
    // write nothing and a terminal run cannot be resumed, so before the
    // convergence this false pass repeated for good.
    const { home, cwd } = await makeHome({ satisfied: true });
    const state = {
      hosts: ['claude', 'codex'],
      claude: [...ALL_PLUGINS],
      codex: ALL_PLUGINS.filter((p) => p !== 'designer'),
    };
    const run = (argv, subprocess) => boot({ argv, home, cwd, runner: mutableRunner(state), subprocess });
    // engineer stays selected and is Codex hook-bearing, so the closed run holds
    // a REAL attestation — which is what makes the verdict, not just the
    // selection, something the read-only verbs have to re-derive.
    await run(['plan', '--bundle', 'custom', '--plugins', 'runtime,companions,engineer,designer', '--format', 'json'], spySubprocess().runner);

    const attestationForEngineerOnly = {
      run_id: 'settings-20260718T030000Z-aa11bb',
      mode: 'attest-codex-hook-review',
      requested: true,
      attested: true,
      status: 'attested',
      host: 'codex',
      attested_at: '2026-07-18T03:00:00Z',
      bundled_plugins: ['engineer'],
      attested_plugins: ['engineer'],
      plugin_versions: { engineer: '9.9.9' },
      bound_versions: { codex: '0.140.0', plugins: { codex: { engineer: '9.9.9' } } },
      artifact_pointer: '~/.agentic-plugins/runs/settings/settings-20260718T030000Z-aa11bb/settings.json',
      artifact_hash: 'b'.repeat(64),
    };
    const executorStdout = JSON.stringify({
      schema_version: 'runtime-doctor-1.0',
      settings_runs: {
        status: 'ok',
        count: 1,
        malformed: 0,
        codex_hook_review: { status: 'attested', current: true, currency_reason: null, latest: attestationForEngineerOnly },
      },
      ...SMOKE_SECTION,
    });

    const answersPath = join(home, 'decline-then-install-later.json');
    await writeFile(answersPath, JSON.stringify([
      { step_id: 'plugin.designer.codex.installed', answer: 'decline' },
      { step_id: 'plugin.designer.codex.enabled', answer: 'decline' },
      { step_id: 'config.session', answer: 'decline' },
      { step_id: 'proof.deep-peer-smoke', answer: 'execute' },
    ]));
    // Nothing moves during the proof here — this is the OTHER window.
    const resume = await run(['resume', '--latest-open', '--answers', answersPath],
      smokeDoctorStub(async () => {}, { stdout: executorStdout }));
    // CONTROL: the run really did close on the narrowed selection with the
    // attestation satisfied, so what the read-only verbs say below is about the
    // later install and nothing else.
    strictEqual(resume.report.steps.find((s) => s.id === 'plugin.designer.codex.installed')?.status, 'declined',
      'precondition: the refusal stands while the machine agrees with it');
    strictEqual(resume.report.steps.find((s) => s.id === 'hooks.codex.attested')?.status, 'satisfied',
      'precondition: the claim covers the narrowed Codex hook set, so the step is genuinely satisfied');

    // The operator installs it on Codex AFTER the run closed.
    state.codex = [...state.codex, 'designer'];
    for (const verb of ['status', 'verify']) {
      const r0 = await run([verb, '--format', 'json'], spySubprocess().runner);
      strictEqual(r0.report.steps.find((s) => s.id === 'plugin.designer.codex.installed')?.status, 'satisfied',
        `${verb}: the observation clears the decline (§6.2) — this half always worked`);
      // Both halves of the convergence are load-bearing here: without the
      // re-derived selection designer never rejoins the Codex hook set, and
      // without the re-derived VERDICT the claim that covered only the narrow
      // set keeps satisfying a step it no longer covers.
      strictEqual(r0.report.steps.find((s) => s.id === 'hooks.codex.attested')?.status, 'pending',
        `${verb}: designer rejoins the Codex hook set and the recorded claim does not cover it`);
      notStrictEqual(r0.report.completion?.state, 'complete',
        `${verb}: so a hook-bearing plugin nobody attested cannot leave the run reading complete`);
    }
  });

  it('the convergence is REPORTED by the read-only verbs, not applied silently', async () => {
    // A refusal that stopped following from the run's own rows is an operator
    // decision that has lapsed; without the warning the only visible effect is a
    // completion that quietly stopped being complete.
    const { home, cwd } = await makeHome({ satisfied: true });
    const state = {
      hosts: ['claude', 'codex'],
      claude: [...ALL_PLUGINS],
      codex: ALL_PLUGINS.filter((p) => p !== 'designer'),
    };
    const run = (argv, subprocess) => boot({ argv, home, cwd, runner: mutableRunner(state), subprocess });
    await run(['plan', '--bundle', 'custom', '--plugins', 'runtime,companions,designer', '--format', 'json'], spySubprocess().runner);
    const answersPath = join(home, 'decline-designer-codex-quiet.json');
    await writeFile(answersPath, JSON.stringify([
      { step_id: 'plugin.designer.codex.installed', answer: 'decline' },
      { step_id: 'plugin.designer.codex.enabled', answer: 'decline' },
      { step_id: 'config.session', answer: 'decline' },
      { step_id: 'proof.deep-peer-smoke', answer: 'execute' },
      { step_id: 'proof.permission', answer: 'execute' },
    ]));
    const resume = await run(['resume', '--latest-open', '--answers', answersPath], smokeDoctorStub(async () => {}));
    ok(!(resume.report.warnings ?? []).some((w) => /refused on codex/.test(w)),
      `precondition: nothing has lapsed while the machine agrees with the refusal: ${JSON.stringify(resume.report.warnings)}`);

    state.codex = [...state.codex, 'designer'];
    for (const verb of ['status', 'verify']) {
      const r0 = await run([verb, '--format', 'json'], spySubprocess().runner);
      ok((r0.report.warnings ?? []).some((w) => /designer/.test(w) && /refused on codex/.test(w) && /re-plan/.test(w)),
        `${verb} names the lapsed refusal and the route back: ${JSON.stringify(r0.report.warnings)}`);
    }
  });

  it('the answered rows are re-judged even when NOTHING ran — resume and status agree about the dependency graph', async () => {
    // The skip this replaces was justified by "identical inputs"; applyAnswers
    // mutates rows in place, so they are not identical. Without the pass resume
    // reports a step `blocked` behind a predecessor the same report shows
    // `declined`, and an immediate status reports it `pending`.
    //
    // designer is on Claude and absent on Codex, so `plugin.designer.codex.enabled`
    // is blocked behind a PENDING `plugin.designer.codex.installed` — a declinable
    // predecessor this resume's own answer then resolves. A host-scoped decline
    // keeps the plugin, so the dependent stays in the expectation.
    const { home, cwd } = await makeHome({ satisfied: true });
    const state = { hosts: ['claude', 'codex'], claude: [...ALL_PLUGINS], codex: ALL_PLUGINS.filter((p) => p !== 'designer') };
    const run = (argv) => boot({ argv, home, cwd, runner: mutableRunner(state), subprocess: spySubprocess().runner });
    const plan = await run(['plan', '--bundle', 'custom', '--plugins', 'runtime,companions,designer', '--format', 'json']);
    strictEqual(plan.report.steps.find((s) => s.id === 'plugin.designer.codex.enabled')?.status, 'blocked',
      'precondition: the dependent starts blocked behind its pending predecessor');

    const answersPath = join(home, 'decline-predecessor.json');
    await writeFile(answersPath, JSON.stringify([
      { step_id: 'plugin.designer.codex.installed', answer: 'decline' },
      { step_id: 'config.session', answer: 'decline' },
    ]));
    const resume = await run(['resume', '--latest-open', '--answers', answersPath, '--format', 'json']);
    // CONTROL: no child ran, so this is the no-snapshot-movement path — the one
    // the old gate skipped.
    strictEqual(resume.report.steps.find((s) => s.id === 'plugin.designer.codex.installed')?.status, 'declined',
      'precondition: the predecessor is resolved by this resume\'s own answer');

    const status = await run(['status', '--format', 'json']);
    const resumeRow = resume.report.steps.find((s) => s.id === 'plugin.designer.codex.enabled');
    const statusRow = status.report.steps.find((s) => s.id === 'plugin.designer.codex.enabled');
    ok(resumeRow, 'precondition: the dependent is still expected after a host-scoped decline');
    strictEqual(resumeRow?.status, statusRow?.status,
      `resume and status must agree about the row (resume=${resumeRow?.status}, status=${statusRow?.status})`);
    notStrictEqual(resumeRow?.status, 'blocked', 'the declined predecessor converges the dependent in the same resume');
    ok(!/resolve the predecessor first/.test(resumeRow?.recovery ?? ''),
      `and the recovery must not send the operator after a predecessor already declined: ${resumeRow?.recovery}`);
  });
  it('a doctor child that ran and then FAILED to produce importable evidence still triggers the final snapshot', async () => {
    // The trigger is the SPAWN, not the import. A doctor invocation that returns
    // unparseable output imports nothing while the machine had the whole run of
    // that child to move; gating the re-probe on the import made the failure path
    // the one that persisted and reported stale facts.
    const { home, cwd } = await makeHome({ satisfied: true });
    const state = { hosts: ['claude', 'codex'], installed: [...ALL_PLUGINS] };
    const run = (argv, subprocess) => boot({ argv, home, cwd, runner: mutableRunner(state), subprocess });

    const plan = await run(['plan', '--bundle', 'base', '--format', 'json'], spySubprocess().runner);
    const runId = plan.report.run_id;
    strictEqual(plan.report.steps.find((s) => s.id === 'plugin.attention.claude.installed')?.status, 'satisfied',
      'precondition: attention is installed and satisfied at plan time');

    const resume = await run(['resume', '--latest-open', '--answers', await writeSmokeAnswers(home)],
      smokeDoctorStub(async () => { state.installed = ALL_PLUGINS.filter((p) => p !== 'attention'); },
        { stdout: '{ this is not json' }));

    ok((resume.report.warnings ?? []).some((w) => /not valid JSON/i.test(w)),
      `precondition: the executor really did fail to import (got ${JSON.stringify(resume.report.warnings)})`);
    let proofExists = true;
    try { await readFile(join(home, '.agentic-plugins', 'runs', 'bootstrap', runId, 'proof', 'deep-peer-smoke.json')); } catch { proofExists = false; }
    strictEqual(proofExists, false, 'precondition: nothing was imported, so the old import-gated flag would have stayed false');

    const manifest = await manifestOf(home, runId);
    strictEqual(manifest.probe.hosts.claude.plugins.attention.state, 'missing',
      'the machine is re-probed after the child, however that child ended');
    strictEqual(manifest.steps.find((s) => s.id === 'plugin.attention.claude.installed')?.status, 'pending',
      'and the persisted rows are judged from that probe, not from the pre-execution one');
  });

  it('the final reduce re-reads the READERS: a user-global config changed DURING the proof is judged post-execution', async () => {
    // The readers half of the one final snapshot. The Codex statusline judge
    // reads $CODEX_HOME/config.toml through the reader snapshot, so a snapshot
    // taken before the executor would persist a row judged from a config the
    // operator has since changed.
    const { home, cwd } = await makeHome({ satisfied: true });
    const codexConfig = join(home, '.codex', 'config.toml');
    await writeFile(codexConfig, '# empty\n');
    const state = { hosts: ['claude', 'codex'], installed: [...ALL_PLUGINS] };
    const run = (argv, subprocess) => boot({ argv, home, cwd, runner: mutableRunner(state), subprocess });
    const plan = await run(['plan', '--bundle', 'base', '--format', 'json'], spySubprocess().runner);
    const runId = plan.report.run_id;
    // CONTROL: the step is open before the proof, so a satisfied row below can
    // only come from the post-execution read.
    strictEqual(plan.report.steps.find((s) => s.id === 'statusline.codex.configured')?.status, 'pending',
      'precondition: the Codex statusline is not configured at plan time');

    const resume = await run(
      ['resume', '--latest-open', '--answers', await writeSmokeAnswers(home)],
      smokeDoctorStub(async () => {
        await writeFile(codexConfig, '[tui]\nstatus_line = ["model-with-reasoning", "git-branch", "pull-request-number", "context-used", "five-hour-limit", "weekly-limit"]\n');
      }),
    );
    strictEqual(resume.report.steps.find((s) => s.id === 'statusline.codex.configured')?.status, 'satisfied',
      'the row is judged from the readers taken after the executor');
    strictEqual((await manifestOf(home, runId)).steps.find((s) => s.id === 'statusline.codex.configured')?.status, 'satisfied',
      'and the persisted row agrees');
  });

  it('the READ-ONLY hook-attestation doctor is a child too — a machine that moves during it is re-probed', async () => {
    // The second spawn site. Every other case here runs an EXECUTOR, so a
    // mutation removing the flag at this site would evade all of them: the
    // attestation fetch is read-only but still a subprocess with a two-minute
    // ceiling, and the machine has exactly as long to move.
    const { home, cwd } = await makeHome({ satisfied: true });
    const state = { hosts: ['claude', 'codex'], installed: [...ALL_PLUGINS] };
    // engineer is Codex hook-bearing, so `hooks.codex.attested` applies and the
    // read-only doctor fetch runs; no answer executes anything.
    const run = (argv, subprocess) => boot({ argv, home, cwd, runner: mutableRunner(state), subprocess });
    const plan = await run(['plan', '--bundle', 'custom', '--plugins', 'runtime,companions,engineer', '--format', 'json'], spySubprocess().runner);
    const runId = plan.report.run_id;
    strictEqual(plan.report.steps.find((s) => s.id === 'plugin.engineer.claude.installed')?.status, 'satisfied',
      'precondition: engineer is installed and satisfied at plan time');
    strictEqual(plan.report.steps.find((s) => s.id === 'hooks.codex.attested')?.status, 'pending',
      'precondition: the attestation step is open, which is what makes the read-only fetch run');

    const calls = [];
    const readOnlyDoctorStub = async (scriptPath, args) => {
      if (scriptPath.endsWith('settings.mjs')) return okOut(JSON.stringify({ plugin_management: { plan_hash: null } }));
      if (scriptPath.endsWith('doctor.mjs')) {
        calls.push([...args]);
        // The operator uninstalls a SELECTED plugin while the fetch runs.
        // `engineer`, not `attention`: this run's selection is
        // runtime,companions,engineer, and a plugin outside the selection has no
        // step row to observe (the first draft asserted on one and failed).
        state.installed = ALL_PLUGINS.filter((p) => p !== 'engineer');
        return okOut(JSON.stringify({
          schema_version: 'runtime-doctor-1.0',
          settings_runs: { status: 'ok', count: 1, malformed: 0, codex_hook_review: { status: 'absent', current: false, currency_reason: null, latest: null } },
        }));
      }
      return missing();
    };
    const answersPath = join(home, 'no-executor.json');
    await writeFile(answersPath, JSON.stringify([{ step_id: 'config.session', answer: 'decline' }]));
    await run(['resume', '--latest-open', '--answers', answersPath], readOnlyDoctorStub);

    // CONTROL: the only child really was the read-only fetch.
    strictEqual(calls.length, 1, `exactly one doctor call: ${JSON.stringify(calls)}`);
    ok(!calls[0].some((a) => a.startsWith('--execute-')), `and it is not an executor: ${JSON.stringify(calls[0])}`);

    const manifest = await manifestOf(home, runId);
    strictEqual(manifest.probe.hosts.claude.plugins.engineer.state, 'missing',
      'the re-probe happens for the read-only child as well');
    strictEqual(manifest.steps.find((s) => s.id === 'plugin.engineer.claude.installed')?.status, 'pending',
      'and the persisted rows are judged from it');
  });
});

// The refactor that made the reader snapshot ONE read per file: these pin the
// projections against the per-family readers they replaced, so a future edit
// cannot quietly change what a family resolves to while collapsing the reads.
describe('bootstrap user-global readers — one read per file (projection equivalence)', () => {
  it('the runtime-config projections equal the per-family readers they replaced', async () => {
    const { home } = await makeHome({ satisfied: true });
    const snapshot = await readUserGlobalRuntimeConfig({ homeDir: home });
    deepStrictEqual(projectModelEffort(snapshot), await readUserGlobalModelEffort({ homeDir: home }));
    // Not vacuous: the fixture really carries the family.
    strictEqual(projectModelEffort(snapshot).keys.model.value, 'gpt-5.2-codex');
  });
});

// ---------------------------------------------------------------------------
// Stage-8 presentation — control disposition vs evidence verdict
//
// The defect this pins: `renderText` printed a Stage-8 proof TWICE — once from
// `completion.proofs[]` (the reducer's evidence verdict) and once from the
// generic unresolved-step loop (the control row, which proof judgement leaves
// at `pending`/`blocked`). The two rows looked like peers and disagreed, and a
// live-fire operator read a passed proof as a failure. The two axes are
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
  // schema-VALID — and its input is not grammar-clamped: the Codex
  // plugin-list version is copied through as any string
  // (lib/machine-probe.mjs). So a reason can forge an output row unless the
  // renderer single-lines it.
  //
  // The historical path is no longer part of this obligation: under the §3.2
  // disclosure invariant it renders from a projection carrying no free text at
  // all (see the schema-minor migration suite). These cases therefore exercise
  // the CURRENT completion path, which still interpolates unclamped strings.
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

  it('an unbounded reason aggregate is bounded rather than printed whole', () => {
    const text = renderText({
      verb: 'status',
      completion: completionOf([evaluatedProof({ reasons: Array.from({ length: 64 }, (_, i) => `${'x'.repeat(500)}-${i}`) })]),
      steps: [],
    });
    const evidenceLines = text.split('\n').filter((line) => /^ {6}evidence: /.test(line));
    ok(evidenceLines.length > 0, 'the reasons render on evidence lines');
    for (const line of evidenceLines) ok(line.length < 600, `each line is bounded, got ${line.length} chars`);
    const total = evidenceLines.reduce((n, line) => n + line.length, 0);
    ok(total < 2400, `the block as a whole is bounded, got ${total} chars`);
  });

  it('a long leading reason cannot spend a later reason\'s budget', () => {
    // The defect this policy replaced: `reasons.join("; ")` through one
    // tail-truncated line is first-come, so the leader below (an unbounded
    // SemVer build identifier, which the grammar permits and the probe carries
    // through verbatim) consumed the whole 400-char budget and the three
    // ACTIONABLE reasons after it rendered as nothing at all.
    const actionable = [
      'plugin runtime is not installed on codex',
      'companions bridge smoke did not run on this host',
      'permission proof did not run on this host',
    ];
    const text = renderText({
      verb: 'status',
      completion: completionOf([evaluatedProof({
        reasons: [`claude engineer 0.21.0 → 0.21.0+${'b'.repeat(360)}`, ...actionable],
      })]),
      steps: [],
    });
    for (const reason of actionable) {
      ok(text.includes(reason), `"${reason.slice(0, 40)}…" survives the long leader:\n${text}`);
    }
  });

  it('an ordinary full version drift loses no reason at all', () => {
    // Not a contrived input: `boundVersionsFresh` emits one reason per drifting
    // key — 3 scalar keys plus 2 hosts × 8 plugins — so a routine bump reaches
    // 19 short reasons. The old shared 400-char line showed 9 of them and ate
    // the rest silently, which is how this was found.
    const reasons = [
      ...['runtime', 'claude', 'codex'].map((key, i) => `${key} 0.8${i}.0 → 0.8${i}.1`),
      ...['claude', 'codex'].flatMap((host) => ['attention', 'companions', 'designer', 'engineer', 'founder', 'image', 'orchestrator', 'runtime']
        .map((name) => `${host} ${name} 0.21.0 → 0.22.0`)),
    ];
    const text = renderText({
      verb: 'status',
      completion: completionOf([evaluatedProof({ reasons })]),
      steps: [],
    });
    for (const reason of reasons) ok(text.includes(reason), `"${reason}" reaches the operator:\n${text}`);
    ok(!/further reason/.test(text), 'and nothing is claimed omitted, because nothing was');
  });

  it('what did not fit is COUNTED, never dropped silently', () => {
    const text = renderText({
      verb: 'status',
      completion: completionOf([evaluatedProof({ reasons: Array.from({ length: 64 }, (_, i) => `reason-${i}-${'x'.repeat(500)}`) })]),
      steps: [],
    });
    const marker = text.split('\n').find((line) => /^ {6}evidence-omitted: /.test(line));
    ok(marker, `the block admits it is incomplete:\n${text}`);
    const shown = text.split('\n').filter((line) => /^ {6}evidence: /.test(line)).length;
    const claimed = Number(/\+(\d+) further/.exec(marker)?.[1]);
    strictEqual(shown + claimed, 64, 'the count reconciles with what was actually shown — a marker that disagrees is a second lie');
  });

  it('a BLANK reason is counted even though it is not rendered', () => {
    // `maxLength` with no `minLength` makes "" and "   " schema-valid, so
    // filtering them before the accounting let a record hold two entries, show
    // one, and claim nothing was omitted (Refine-verify peer, MAJOR).
    const text = renderText({
      verb: 'status',
      completion: completionOf([evaluatedProof({ reasons: ['   ', 'REAL_REASON'] })]),
      steps: [],
    });
    ok(/^ {6}evidence: REAL_REASON$/m.test(text), `the real reason renders:\n${text}`);
    const marker = text.split('\n').find((line) => /^ {6}evidence-omitted: /.test(line));
    ok(marker, `the blank entry is declared, not silently filtered:\n${text}`);
    ok(/\+1 further entry not shown \(1 blank\)/.test(marker), `and named as blank: ${marker}`);
  });

  it('a reason cannot forge the omission marker', () => {
    // The marker and the reasons shared one label, so a reason reading like a
    // marker rendered byte-for-byte as one, claiming an omission that never
    // happened (Refine-verify peer, MAJOR).
    const forged = '(+63 further reasons not shown; read the run artifact for the full set)';
    const text = renderText({
      verb: 'status',
      completion: completionOf([evaluatedProof({ reasons: [forged] })]),
      steps: [],
    });
    ok(!/^ {6}evidence-omitted: /m.test(text), `no line claims an omission the renderer did not make:\n${text}`);
    ok(text.includes(`      evidence: ${forged}`), 'the text still renders, as the record\'s own words');
  });

  it('every grapheme cluster family survives the cut, not only combining marks', () => {
    // The hand-rolled backoff handled \p{M} only, so ZWJ sequences (Cf),
    // regional-indicator pairs (So) and emoji modifiers (Sk) all still split —
    // none of those are marks (Refine-verify peer, MAJOR). Enumerating Unicode
    // categories by hand is what missed three of four families; the segmenter
    // is UAX #29 itself.
    const families = [
      ['ZWJ sequence', '\u{1F469}\u200D\u{1F4BB}', '\u{1F469}'],
      ['regional indicators', '\u{1F1F0}\u{1F1F7}', '\u{1F1F0}'],
      ['emoji modifier', '\u{1F44D}\u{1F3FD}', '\u{1F44D}'],
      ['combining mark', 'e\u0301', 'e'],
    ];
    for (const [name, cluster, leadingPiece] of families) {
      const text = renderText({
        verb: 'status',
        completion: completionOf([evaluatedProof({ reasons: [`${'x'.repeat(397)}${cluster}TAIL${'y'.repeat(100)}`] })]),
        steps: [],
      });
      const line = text.split('\n').find((l) => /^ {6}evidence: /.test(l));
      const payload = line.replace(/^ {6}evidence: /, '').replace(/\u2026$/, '');
      ok(!payload.endsWith(leadingPiece), `${name}: the cluster was split, leaving a different character than the record held: ${JSON.stringify(payload.slice(-4))}`);
    }
  });

  it('a cluster wider than the whole budget yields no corrupted prefix', () => {
    // The old "don't retreat to empty" guard reproduced exactly the stripped
    // base it claimed to prevent: `e` + a budget of combining marks rendered a
    // confident `e` (Refine-verify peer, MAJOR).
    const text = renderText({
      verb: 'status',
      completion: completionOf([evaluatedProof({ reasons: [`e${'\u0301'.repeat(500)}`] })]),
      steps: [],
    });
    const line = text.split('\n').find((l) => /^ {6}evidence: /.test(l));
    const payload = line.replace(/^ {6}evidence: /, '');
    strictEqual(payload, '\u2026', `no prefix of an unsplittable cluster may be presented as the recorded value, got ${JSON.stringify(payload)}`);
  });

  it('the hook attestation reasons reach the operator at all', () => {
    // The second reason array on `completion`, which had no row whatsoever —
    // not truncated, absent (Refine-verify peer, MAJOR).
    const text = renderText({
      verb: 'status',
      completion: { ...completionOf([]), hook_attestation: { status: 'stale', reasons: ['CANARY_A', 'CANARY_B'] } },
      steps: [],
    });
    ok(/^ {2}- hook attestation: stale$/m.test(text), `the verdict renders:\n${text}`);
    for (const canary of ['CANARY_A', 'CANARY_B']) ok(text.includes(canary), `${canary} reaches the operator:\n${text}`);
  });

  it('at least four reasons survive whatever their lengths — the guarantee that replaced zero', () => {
    // Per-line bounding is what makes this a guarantee: with a SHARED budget a
    // single 400-char reason left nothing for anyone else.
    const text = renderText({
      verb: 'status',
      completion: completionOf([evaluatedProof({ reasons: Array.from({ length: 20 }, (_, i) => `r${i}-${'q'.repeat(2000)}`) })]),
      steps: [],
    });
    const shown = text.split('\n').filter((line) => /^ {6}evidence: /.test(line) && !/further reason/.test(line));
    ok(shown.length >= 4, `got ${shown.length} reasons through, expected at least 4:\n${text}`);
    for (const [i, line] of shown.entries()) {
      ok(line.includes(`r${i}-`), `reason ${i} is rendered whole-headed, not spliced: ${line.slice(0, 40)}`);
    }
  });

  it('truncation never strips a combining mark off its base character', () => {
    // The quieter half of the surrogate case below. Cutting `e` + U+0301 after
    // the `e` corrupts nothing visibly — it renders a confident `e`, and the
    // operator cannot tell the source ever said an accented character. 398
    // filler puts the mark exactly on the cut boundary (RENDER_LINE_MAX 400 ->
    // the cut lands at index 399).
    //
    // The mark is written as an ESCAPE, never as a literal. A literal is one
    // editor normalization away from being the precomposed U+00E9, which has no
    // combining mark at all — the backoff would never fire and this test would
    // keep passing while testing nothing. The assert pins that precondition so
    // the fixture cannot rot into a vacuous pass.
    const reason = `${'x'.repeat(398)}e\u0301TAIL${'y'.repeat(100)}`;
    strictEqual(reason.codePointAt(399), 0x0301, 'the fixture must be DECOMPOSED for this test to exercise anything');
    const text = renderText({
      verb: 'status',
      completion: completionOf([evaluatedProof({ reasons: [reason] })]),
      steps: [],
    });
    const line = text.split('\n').find((l) => /^ {6}evidence: /.test(l));
    const payload = line.replace(/^ {6}evidence: /, '').replace(/\u2026$/, '');
    ok(!/e$/.test(payload), `the base was dropped with its mark, not kept without it: ${JSON.stringify(payload.slice(-6))}`);
    ok(!/\u0301/.test(payload), 'and no orphaned mark survives either');
  });

  it('the grapheme backoff is linear, not quadratic, in the retreat distance', () => {
    // The first implementation re-spread the kept prefix (`[...cut]`) on every
    // retreat step, which is quadratic in the run of marks. Measured at 74ms for
    // a schema-max reason set of pure combining marks and 886ms once the input
    // is not schema-bounded — and `renderText` is reachable from a stored
    // run.json, so the schema bound is not a guarantee at this boundary.
    const marks = '\u0301'.repeat(512);
    const started = process.hrtime.bigint();
    const text = renderText({
      verb: 'status',
      completion: completionOf([evaluatedProof({ reasons: Array.from({ length: 64 }, () => marks) })]),
      steps: [],
    });
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    ok(text.includes('evidence:'), 'it still renders');
    // Generous against CI jitter: the quadratic version took ~74ms here, the
    // linear one ~2ms. Anything under 40ms cannot be the quadratic shape.
    ok(elapsedMs < 40, `expected linear-time backoff, took ${elapsedMs.toFixed(1)}ms`);
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
      steps: [controlRow({ status: 'blocked', recovery: 'Blocked by host.claude.authenticated; resolve the predecessor first.' })],
    });
    ok(/^ {2}- \[stage 8\] proof\.deep-peer-smoke: stale$/m.test(text), `verdict:\n${text}`);
    ok(/^ {6}evidence: runtime 0\.86\.0 → 0\.86\.1$/m.test(text), 'the drift reason renders');
    ok(/^ {6}execution: Blocked by host\.claude\.authenticated/m.test(text), 'and the unreachable re-execution is still named');
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
    // could otherwise make deep-peer evidence read as the permission proof.
    const text = renderText({
      verb: 'status',
      completion: completionOf([evaluatedProof({ kind: 'deep-peer-smoke', step_id: 'proof.permission', status: 'passed', reasons: [] })]),
      steps: [
        controlRow({ id: 'proof.permission', status: 'blocked', recovery: 'Blocked by host.codex.authenticated; resolve the predecessor first.' }),
        // The CANONICAL row is present and blocked too, so dropping the join
        // guard would attach THIS context to a record that named another step —
        // without it the mutant survives on a null lookup.
        controlRow({ id: 'proof.deep-peer-smoke', status: 'blocked', recovery: 'Blocked by host.claude.authenticated; resolve the predecessor first.' }),
      ],
    });
    ok(/^ {2}- \[stage 8\] proof\.deep-peer-smoke: passed$/m.test(text), `the row is labelled from the kind:\n${text}`);
    ok(!/proof\.permission/.test(text), 'the disagreeing step_id never labels the row');
    ok(!/execution:/.test(text), 'and it joins NO control context — not the named row, not the canonical one');
  });

  it('hook-attestation reason text cannot fabricate a row', () => {
    const text = renderText({
      verb: 'verify',
      completion: { ...completionOf([]), hook_attestation: { status: 'stale', reasons: ['the claim re-judges stale\n  - [stage 8] proof.forged: passed'] } },
      steps: [],
    });
    ok(!/^\s*- \[stage 8\]/m.test(text), 'the attestation line is sanitized on the same terms');
    // The newline became a space; the two spaces that followed it are PRESERVED
    // (this boundary neutralizes structure, it does not squeeze whitespace —
    // squeezing corrupts operator-facing paths). Neutralized, not dropped.
    ok(/^ {6}reason: the claim re-judges stale {3}- \[stage 8\] proof\.forged: passed$/m.test(text),
      `the reason still renders, neutralized rather than dropped:\n${text}`);
  });

  it('a hook-attestation reason cannot forge a Stage-8 evidence row from its own line', () => {
    // Each reason renders on its own line, which is what lets its leading
    // characters begin a line, so a bare indent would render `evidence: …` as a
    // perfect proof-evidence row. The prefix is a label the renderer wrote.
    const text = renderText({
      verb: 'verify',
      completion: { ...completionOf([]), hook_attestation: { status: 'stale', reasons: ['evidence: deep-peer-smoke passed on both directions'] } },
      steps: [],
    });
    ok(!/^ {6}evidence: /m.test(text), `no line reads as a Stage-8 evidence row:\n${text}`);
    ok(/^ {6}reason: evidence: deep-peer-smoke/m.test(text), 'the text still renders, under a label the renderer wrote');
  });
  it('a duplicated proof kind renders ONE row naming the conflict, never two to choose between', () => {
    // The reducer rejects duplicate evidence rather than picking a record (§8),
    // but `proofs[]` is not unique-by-kind in the schema — so the renderer must
    // not print two identical-looking rows with different verdicts. The
    // historical path enforces the same rule inside projectLegacyCompletion, so
    // it holds in `--format json` too and not only on this rendered line.
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

  it('a report without steps (historical) degrades to evidence-only without throwing', () => {
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
        // ADR-0057 §Decision 5 — `proof.permission` is now ALWAYS applicable, so a run
        // that must terminalize `complete` owes it exactly as it owes the smoke.
        if (args.includes('--execute-permission-proof')) {
          return okOut(JSON.stringify({
            permission_proof: { directions: { claude_to_codex: { execution: 'executed', status: 'passed' }, codex_to_claude: { execution: 'executed', status: 'passed' } } },
            doctor_artifact: { artifact_pointer: '~/.agentic-plugins/runs/doctor/stub/artifact.json' },
          }));
        }
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

    const resume = await run(['resume', '--latest-open', '--answers', await writeSessionDecline(home)]);

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
      { step_id: 'config.session', answer: 'decline' },
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

  // --- the runtime:doctor exit-code ladder ---------------------------------
  //
  // Doctor now reports its findings through its exit code, so `result.ok` — which
  // is only `exit_code === 0` — stopped being a usable gate at both call sites.
  // The machines these two paths run on are exactly the machines with findings:
  // one is mid-bootstrap with hosts that are not ready yet, the other is
  // executing a proof that may legitimately end blocked. The rule is parse the
  // report first, read the code as a classifier.

  /** Wrap a stub so every doctor.mjs answer carries `overrides` instead of ok/0. */
  const withDoctorExit = (base, overrides, mutate = (out) => out) => ({
    calls: base.calls,
    runner: async (scriptPath, args) => {
      const out = await base.runner(scriptPath, args);
      if (!scriptPath.endsWith('doctor.mjs')) return out;
      return { ...mutate(out), ok: false, ...overrides };
    },
  });

  const kindProofPath = (home, runId, kind) => join(home, '.agentic-plugins', 'runs', 'bootstrap', runId, 'proof', `${kind}.json`);

  const executeSmokeAnswers = async (home) => {
    const path = join(home, 'execute-smoke-exit.json');
    await writeFile(path, JSON.stringify([
      { step_id: 'proof.deep-peer-smoke', answer: 'execute' },
      { step_id: 'config.session', answer: 'decline' },
    ]));
    return path;
  };

  it('imports the attestation from a read-only doctor run that exited with findings', async () => {
    const { home, cwd } = await makeHome({ satisfied: true });
    // Identical report, exit 10. Gating on `result.ok` would have stranded the
    // import on every machine whose hosts still have hard failures — which is
    // the machine bootstrap exists to walk through.
    const stub = withDoctorExit(hookDoctorStub({ review: currentReview() }), { exit_code: 10 });
    const { run, runId } = await planEngineering(home, cwd, stub);

    await run(['resume', '--latest-open', '--answers', await writeSessionDecline(home)]);

    const recorded = JSON.parse(await readFile(proofPath(home, runId), 'utf8'));
    strictEqual(recorded.status, 'attested');
    deepStrictEqual(recorded.attested_plugins, HOOK_PLUGINS);
  });

  it('still refuses a read-only doctor run that produced no report at all', async () => {
    // Control for the case above: the gate moved from the exit code onto the
    // report, so an ABSENT report must still be refused. Without this, "parse
    // stdout first" could degrade into "never fail".
    const { home, cwd } = await makeHome({ satisfied: true });
    const stub = withDoctorExit(
      hookDoctorStub({ review: currentReview() }),
      { exit_code: null, error_code: 'ETIMEDOUT' },
      (out) => ({ ...out, stdout: '' }),
    );
    const { run, runId } = await planEngineering(home, cwd, stub);

    const resume = await run(['resume', '--latest-open', '--answers', await writeSessionDecline(home)]);

    await rejects(() => readFile(proofPath(home, runId), 'utf8'), /ENOENT/, 'nothing may be imported from a report that does not exist');
    ok((resume.report.warnings ?? []).some((w) => /could not be run \(ETIMEDOUT\)/.test(w)), `the absent report is named: ${JSON.stringify(resume.report.warnings)}`);
  });

  it('refuses a report from an exit code that carries no report contract', async () => {
    // "Parse stdout first" must not become "never fail". A child that dies after
    // buffering JSON — a crash, a signal, or a future code this runtime has no
    // contract for — is not a diagnosis, however parseable its output is.
    const { home, cwd } = await makeHome({ satisfied: true });
    const stub = withDoctorExit(hookDoctorStub({ review: currentReview() }), { exit_code: 99 });
    const { run, runId } = await planEngineering(home, cwd, stub);

    const resume = await run(['resume', '--latest-open', '--answers', await writeSessionDecline(home)]);

    await rejects(() => readFile(proofPath(home, runId), 'utf8'), /ENOENT/, 'an uncontracted exit fabricates no evidence');
    ok((resume.report.warnings ?? []).some((w) => /exited 99, which carries no report contract/.test(w)), `the refusal names the code: ${JSON.stringify(resume.report.warnings)}`);
    // CONTROL: the identical report at a CONTRACTED non-zero code imports. Without
    // this the assertion above would also pass if the reader refused everything.
    const okStub = withDoctorExit(hookDoctorStub({ review: currentReview() }), { exit_code: 10 });
    const second = await makeHome({ satisfied: true });
    const okRun = await planEngineering(second.home, second.cwd, okStub);
    await okRun.run(['resume', '--latest-open', '--answers', await writeSessionDecline(second.home)]);
    strictEqual(JSON.parse(await readFile(proofPath(second.home, okRun.runId), 'utf8')).status, 'attested');
  });

  it('imports an executed proof whose doctor run exited with findings', async () => {
    const { home, cwd } = await makeHome({ satisfied: true });
    const stub = withDoctorExit(hookDoctorStub({ review: currentReview(), serveSmoke: true }), { exit_code: 10 });
    const { run, runId } = await planEngineering(home, cwd, stub);

    await run(['resume', '--latest-open', '--answers', await executeSmokeAnswers(home)]);

    const recorded = JSON.parse(await readFile(kindProofPath(home, runId, 'deep-peer-smoke'), 'utf8'));
    ok(recorded, 'the proof metadata is imported from the report, not discarded with the exit code');
  });

  it('refuses to import a proof whose artifact could not be persisted (exit 40)', async () => {
    // The proof may well have RUN. §8.2 imports its metadata alongside the
    // artifact's exact-byte hash, and there is no artifact — a record stored
    // here would carry an `artifact_hash` nothing can verify.
    const { home, cwd } = await makeHome({ satisfied: true });
    const stub = withDoctorExit(
      hookDoctorStub({ review: currentReview(), serveSmoke: true }),
      { exit_code: 40 },
      (out) => {
        const report = JSON.parse(out.stdout);
        report.doctor_artifact = { requested: true, written: false, status: 'write_failed', error: 'ENOTDIR' };
        return { ...out, stdout: JSON.stringify(report) };
      },
    );
    const { run, runId } = await planEngineering(home, cwd, stub);

    const resume = await run(['resume', '--latest-open', '--answers', await executeSmokeAnswers(home)]);

    await rejects(() => readFile(kindProofPath(home, runId, 'deep-peer-smoke'), 'utf8'), /ENOENT/, 'an unhashable proof is not stored');
    ok((resume.report.warnings ?? []).some((w) => /could not persist its artifact at/.test(w)), `the refusal names the cause: ${JSON.stringify(resume.report.warnings)}`);
    // CONTROL: the read-only half of the same report is still usable — the
    // refusal is scoped to the proof import, not to the whole run.
    const recorded = JSON.parse(await readFile(proofPath(home, runId), 'utf8'));
    deepStrictEqual(recorded.attested_plugins, HOOK_PLUGINS);
  });

  it('the imported claim satisfies the hook step in the SAME resume, not the next one', async () => {
    const { home, cwd } = await makeHome({ satisfied: true });
    const stub = hookDoctorStub({ review: currentReview() });
    const { run } = await planEngineering(home, cwd, stub);

    const resume = await run(['resume', '--latest-open', '--answers', await writeSessionDecline(home)]);

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
    const resume = await run(['resume', '--latest-open', '--answers', await writeSessionDecline(home)]);

    strictEqual(resume.report.steps.find((s) => s.id === 'hooks.codex.attested')?.status, 'satisfied', 'the import still lands');
    const session = resume.report.steps.find((s) => s.id === 'config.session');
    strictEqual(session?.status, 'declined', `the decline survives the re-judge: ${JSON.stringify(session)}`);
    strictEqual(session.fragment_pointer ?? null, null, 'a refused hand-off is not re-offered');
    strictEqual(session.apply_command ?? null, null);
    strictEqual(session.desired ?? null, null);

    // The persisted manifest must agree with the report — choices, history and
    // the step row are three views of one decision.
    const manifest = JSON.parse(await readFile(join(home, '.agentic-plugins', 'runs', 'bootstrap', runId, 'run.json'), 'utf8'));
    strictEqual(manifest.steps.find((s) => s.id === 'config.session')?.status, 'declined');
    ok(manifest.choices.some((c) => c.step_id === 'config.session' && c.answer === 'decline'), 'the choice ledger records it');
    ok(manifest.history.some((h) => h.step_id === 'config.session' && h.to === 'declined'), 'and history agrees with the row');
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
      { step_id: 'config.session', answer: 'decline' },
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

  it('legacy Stage-6 rows in a current-schema run are dropped by the re-judge, as stated', async () => {
    const { home, cwd } = await makeHome({ satisfied: true });
    const stub = hookDoctorStub({ review: currentReview() });
    const { run, runId } = await planEngineering(home, cwd, stub);

    const runPath = join(home, '.agentic-plugins', 'runs', 'bootstrap', runId, 'run.json');
    const seeded = JSON.parse(await readFile(runPath, 'utf8'));
    // ADR-0057 open-run migration, seeded here because this runtime can no longer
    // PRODUCE a Stage-6 row: a run planned by a pre-removal runtime carries
    // `permission.<host>.applied` rows (one with `fragment_applied: true`) that the
    // registry no longer expects. The assertion at the end of this test pins what
    // resume does with them.
    seeded.steps.push(
      { id: 'permission.claude.applied', stage: 6, status: 'satisfied', declinable: true, blocked_by: ['host.claude.present'], fragment_applied: true },
      { id: 'permission.codex.applied', stage: 6, status: 'pending', declinable: true, blocked_by: ['host.codex.present'], fragment_applied: false },
    );
    await writeFile(runPath, `${JSON.stringify(seeded, null, 2)}\n`);
    // PRE-CONTROL for the absence assertion at the end of this test: an
    // `is-empty` check passes for free if the seed never landed, so pin that
    // the rows are really there to be dropped BEFORE the verb runs.
    strictEqual(
      JSON.parse(await readFile(runPath, 'utf8')).steps.filter((step) => /^permission\.[a-z]+\.applied$/.test(step.id)).length,
      2,
      'pre-control: the pre-removal run really carries two Stage-6 rows going in',
    );

    const resume = await run(['resume', '--latest-open', '--answers', await writeSessionDecline(home)]);

    // ADR-0057 open-run migration, MEASURED rather than assumed: `judgeSteps`
    // rebuilds steps[] from the EXPECTATION, so rows the registry no longer emits
    // do not survive a resume. An open pre-removal run therefore migrates by
    // DROPPING its Stage-6 rows — it is not refused, and the operator does not
    // re-plan. `fragment_applied` goes with them, which is why the schema now
    // describes the field as legacy-only rather than deleting it (retained
    // TERMINAL runs are never re-judged, so their rows keep their bytes).
    deepStrictEqual(
      resume.report.steps.filter((step) => /^permission\.[a-z]+\.applied$/.test(step.id)),
      [],
      'a pre-removal run resumes with its Stage-6 rows dropped, not refused',
    );
    // Non-vacuity: the seed really was there to be dropped.
    const seededAgain = JSON.parse(await readFile(runPath, 'utf8'));
    ok(!seededAgain.steps.some((step) => /^permission\.[a-z]+\.applied$/.test(step.id)),
      'and the persisted manifest no longer carries them either');
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

    const resume = await run(['resume', '--latest-open', '--answers', await writeSessionDecline(home)]);

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

    const resume = await run(['resume', '--latest-open', '--answers', await writeSessionDecline(home)]);

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
    const decline = await writeSessionDecline(home);

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

      const resume = await run(['resume', '--latest-open', '--answers', await writeSessionDecline(home)]);
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

      const resume = await run(['resume', '--latest-open', '--answers', await writeSessionDecline(home)]);
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

    const resume = await run(['resume', '--latest-open', '--answers', await writeSessionDecline(home)]);

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

    const resume = await run(['resume', '--latest-open', '--answers', await writeSessionDecline(home)]);

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

    const resume = await run(['resume', '--latest-open', '--answers', await writeSessionDecline(home)]);
    // The shared doctor reader states the failure; the call site appends which
    // import it belongs to. Both facts must still appear, and the failure code
    // now does too — a stricter assertion than the single-sentence form it
    // replaces, not a looser one.
    ok((resume.report.warnings ?? []).some((w) => /runtime:doctor could not be run \(ENOENT\).*Codex \/hooks attestation/.test(w)), `a failed fetch is stated: ${JSON.stringify(resume.report.warnings)}`);
  });

  it('the base bundle carries no Codex hook-bearing plugin, so the import is not attempted at all', async () => {
    const { home, cwd } = await makeHome({ satisfied: true });
    const stub = hookDoctorStub({ review: currentReview() });
    const run = (argv) => boot({ argv, home, cwd, runner: hostedRunner(), subprocess: stub.runner });
    await run(['plan', '--bundle', 'base', '--format', 'json']);

    const resume = await run(['resume', '--latest-open', '--answers', await writeSessionDecline(home)]);
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
      // ADR-0057 §Decision 5 — `proof.permission` is now ALWAYS applicable, so a run
      // that must terminalize `complete` owes it exactly as it owes the smoke.
      if (args.includes('--execute-permission-proof')) {
        return okOut(JSON.stringify({
          permission_proof: { directions: { claude_to_codex: { execution: 'executed', status: 'passed' }, codex_to_claude: { execution: 'executed', status: 'passed' } } },
          doctor_artifact: { artifact_pointer: '~/.agentic-plugins/runs/doctor/stub/artifact.json' },
        }));
      }
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
    { step_id: 'config.session', answer: 'decline' },
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

    // And the persisted document is a current-schema manifest — the narrowing
    // needed no schema addition, which is what keeps an older runtime able to read
    // this run (§4.1: an unknown non-scalar key is refused at EVERY minor).
    strictEqual(manifest.schema, 'runtime-bootstrap-run-1.5');
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

// ---------------------------------------------------------------------------
// §6.1.1 — Stage 4 asks for a recorded model/effort POSTURE, not for a key
// ---------------------------------------------------------------------------

describe('runtime bootstrap CLI — §6.1.1 the model/effort posture', () => {
  const configPath = (home) => join(home, '.agentic-plugins', 'config.toml');

  async function writeConfig(home, body) {
    await writeFile(configPath(home), body);
  }

  const stub = async (scriptPath) => {
    if (scriptPath.endsWith('settings.mjs')) return okOut(JSON.stringify({ plugin_management: { plan_hash: null } }));
    if (scriptPath.endsWith('doctor.mjs')) return okOut(JSON.stringify({}));
    return missing();
  };

  const stage4Of = (report) => report.steps.find((s) => s.id === 'config.model_effort');

  async function planWith(body) {
    const { home, cwd } = await makeHome({ satisfied: true });
    await writeConfig(home, body);
    const run = (argv) => boot({ argv, home, cwd, runner: hostedRunner(), subprocess: stub });
    const plan = await run(['plan', '--bundle', 'base', '--format', 'json']);
    return { home, cwd, run, plan, step: stage4Of(plan.report) };
  }

  it('an explicit coordinate satisfies it — unchanged behaviour', async () => {
    const { step } = await planWith('model = "gpt-5.2-codex"\neffort = "high"\n');
    strictEqual(step.status, 'satisfied');
    ok(/model=gpt-5\.2-codex/.test(step.observed), step.observed);
  });

  it('CONTROL — no coordinate and no posture stays pending, and NAMES the posture route', async () => {
    const { step } = await planWith('');
    strictEqual(step.status, 'pending');
    ok(/model-effort-fallback host-native/.test(step.recovery), `the recovery offers the declaration: ${step.recovery}`);
    // This is the state the dogfood machine was stuck in: pending forever on a
    // step whose only documented remedy was to configure what it deliberately
    // left unset.
    strictEqual(step.declinable, false, 'and it is still not declinable — a decline is the wrong sentence');
  });

  it('a recorded host-native posture satisfies it with NO coordinate set', async () => {
    const { step } = await planWith('model_effort_fallback = "host-native"\n');
    strictEqual(step.status, 'satisfied');
    ok(/model_effort_fallback=host-native/.test(step.observed), step.observed);
    ok(/the host chooses/.test(step.observed), 'the observation says who decides, not just that a key exists');
  });

  it('an EMPTY coordinate is not a coordinate — the presence test counted it', async () => {
    const { step } = await planWith('model = ""\n');
    // The parser preserves a known key with an empty value on purpose (so the
    // per-key validator can fail closed on it), and `!= null` read that as
    // configured — a step satisfied by a value that resolves to nothing.
    strictEqual(step.status, 'pending');
  });

  it('an INVALID posture is pending with the valid set named, never satisfied', async () => {
    const { step } = await planWith('model_effort_fallback = "whatever-the-host-wants"\n');
    strictEqual(step.status, 'pending');
    ok(/must be one of host-native/.test(step.recovery), step.recovery);
    ok(/whatever-the-host-wants/.test(step.observed ?? ''), 'the offending value is echoed so the operator can find it');
  });

  it('an explicit coordinate WINS over the posture — the posture is a fallback', async () => {
    const { step } = await planWith('model = "gpt-5.2-codex"\nmodel_effort_fallback = "host-native"\n');
    strictEqual(step.status, 'satisfied');
    ok(/model=gpt-5\.2-codex/.test(step.observed), 'the coordinate is what is reported');
    ok(!/model_effort_fallback/.test(step.observed), 'the posture does not claim credit for a coordinate that is set');
  });

  it('an UNREADABLE user config is unknown, never "nothing set"', async () => {
    const { home, cwd } = await makeHome({ satisfied: true });
    // A directory where the file belongs: the read fails with EISDIR, which is
    // neither readable nor ENOENT-missing.
    await rm(configPath(home), { force: true });
    await mkdir(configPath(home), { recursive: true });
    const plan = await boot({ argv: ['plan', '--bundle', 'base', '--format', 'json'], home, cwd, runner: hostedRunner(), subprocess: stub });
    const step = stage4Of(plan.report);
    strictEqual(step.status, 'unknown', `an unreadable config is not an absent one: ${JSON.stringify(step)}`);
    ok(/could not be read/.test(step.recovery), step.recovery);
  });

  it('a run planned before the declaration is NOT credited — it heals on the operator adding it', async () => {
    const { home, cwd } = await makeHome({ satisfied: true });
    await writeConfig(home, '');
    const run = (argv) => boot({ argv, home, cwd, runner: hostedRunner(), subprocess: stub });
    const plan = await run(['plan', '--bundle', 'base', '--format', 'json']);
    strictEqual(stage4Of(plan.report).status, 'pending', 'the old absence is never read as intent');

    // The operator declares the posture, then resumes. Nothing about the run
    // changed — the machine did.
    await writeConfig(home, 'model_effort_fallback = "host-native"\n');
    const resume = await run(['resume', '--latest-open', '--answers', await writeSessionDecline(home)]);
    strictEqual(stage4Of(resume.report).status, 'satisfied');
    ok(!resume.report.completion.unsatisfied.includes('config.model_effort'), 'and the step stops holding completion back');
  });
});

// ---------------------------------------------------------------------------
// D1 — the report-level finding bound (machine-bootstrap-contract.md §3.2)
// ---------------------------------------------------------------------------
//
// The per-artifact cap in lib/schema-validate.mjs bounds ONE validation. A
// single report still aggregates findings from several sources, so the budget is
// spent once more at the report boundary — and, critically, BEFORE the format
// branch, so text and `--format json` cannot disagree about what a report says.

describe('runtime bootstrap CLI — report finding bound (§3.2)', () => {
  const many = (n, label) => Array.from({ length: n }, (_, i) => `${label} ${i}`);

  it('leaves an under-cap report untouched — the bound adds no fields it does not need', () => {
    const report = { verb: 'status', diagnostics: many(4, 'd'), warnings: many(4, 'w') };
    const bounded = boundReportFindings(report);
    strictEqual(bounded, report, 'the same object rides through when nothing was dropped');
    ok(!('findings_omitted' in bounded), 'no decoration on the ordinary path');
  });

  it('spends the budget on diagnostics first, marks the overflow, and keeps the totals', () => {
    const bounded = boundReportFindings({ verb: 'status', diagnostics: many(40, 'd'), warnings: many(10, 'w') });
    strictEqual(bounded.diagnostics.length, REPORT_FINDINGS_MAX + 1, '32 findings plus one fixed marker');
    strictEqual(bounded.warnings.length, 0, 'errors first — warnings yield the budget');
    deepStrictEqual(bounded.finding_counts, { diagnostics: 40, warnings: 10 }, 'the totals are the authority');
    strictEqual(bounded.findings_omitted, true);
    match(bounded.diagnostics.at(-1), /Further findings were omitted/, 'truncation is stated, never silent');
  });

  it('marks the overflow on the warnings list when a report carries no diagnostics', () => {
    // The failure this pins: a marker appended only to `diagnostics` leaves a
    // warnings-only report silently truncated, which reads as "that was
    // everything" — the exact dishonesty the bound exists to prevent.
    const bounded = boundReportFindings({ verb: 'status', warnings: many(50, 'w') });
    strictEqual(bounded.warnings.length, REPORT_FINDINGS_MAX + 1);
    match(bounded.warnings.at(-1), /Further findings were omitted/);
    strictEqual(bounded.findings_omitted, true);
  });

  it('the JSON report identifier is 3.0 — the attest report, the live receipt verdict and the egress proof rows were removed (ADR-0064 Decision 7)', async () => {
    const { home, cwd } = await makeHome({ satisfied: true });
    const result = await boot({ argv: ['status', '--format', 'json'], home, cwd, runner: hostedRunner(), subprocess: spySubprocess().runner });
    strictEqual(JSON.parse(result.rendered).schema, 'runtime-bootstrap-report-3.0', 'the emitted report carries the bumped identifier');
    strictEqual(BOOTSTRAP_REPORT_SCHEMA_VERSION, 'runtime-bootstrap-report-3.0');
    // A plan report is stamped the same way, not only a no-run status.
    const plan = await boot({ argv: ['plan', '--bundle', 'base', '--format', 'json'], home, cwd, runner: hostedRunner(), subprocess: spySubprocess().runner });
    strictEqual(JSON.parse(plan.rendered).schema, 'runtime-bootstrap-report-3.0');
  });
});

// ---------------------------------------------------------------------------
// D1 — the proof-directory scan is on the same boundary (§3.2)
// ---------------------------------------------------------------------------
//
// A directory ENTRY NAME is not clamped by anything: whoever can write into the
// proof directory chooses it. These cases run END TO END through `runBootstrap`
// rather than against the reader in isolation, because that is the only way to
// pin that the report-level bound is actually WIRED — a bound applied after the
// format branch, or not at all, still passes every unit test of the bounding
// function itself.

describe('runtime bootstrap CLI — pre-removal terminal runs are HISTORY, not re-judged (ADR-0057)', () => {
  // The open-run migration is covered above (Stage-6 rows dropped on resume). This is
  // the OTHER half, and it is why the run schema had to move 1.3 -> 1.4 rather than
  // changing the registry under an unchanged stamp.
  //
  // A run that COMPLETED before the removal recorded Stage 6 satisfied and
  // `proof.permission` non-applicable — a legitimate `complete` under its own
  // registry. Under the new registry that proof is always applicable, so re-judging
  // such a run projects `configured-not-verified` over a proof it can never attach:
  // `resume` refuses a terminal run, so there is no path that could ever satisfy it.
  // Bumping the minor routes it to the legacy-terminal boundary instead, which
  // presents it as immutable evidence and re-certifies nothing.
  async function seedTerminalPreRemovalRun(home, runId) {
    const runDir = join(home, '.agentic-plugins', 'runs', 'bootstrap', runId);
    await mkdir(runDir, { recursive: true });
    await writeFile(join(runDir, 'run.json'), `${JSON.stringify({
      schema: 'runtime-bootstrap-run-1.3',
      run_id: runId,
      started_at: '2026-08-01T00:00:00Z',
      updated_at: '2026-08-01T00:00:00Z',
      status: 'complete',
      selection: { bundle: 'base', desired: ['runtime', 'companions', 'attention'], excluded: [] },
      steps: [
        { id: 'permission.claude.applied', stage: 6, status: 'satisfied', declinable: true, blocked_by: ['host.claude.present'], fragment_applied: true },
        { id: 'permission.codex.applied', stage: 6, status: 'satisfied', declinable: true, blocked_by: ['host.codex.present'], fragment_applied: true },
        { id: 'proof.permission', stage: 8, status: 'not-applicable', declinable: true, blocked_by: [] },
      ],
      completion: {
        state: 'complete',
        unsatisfied: [],
        missing_steps: [],
        proofs: [],
        hook_attestation: { status: 'not-applicable', reasons: [], attested_plugins: [], bound_versions: null, artifact_pointer: null, artifact_hash: null, attested_at: null },
      },
      boundary: { writes_host_config: false, writes_credential: false, writes_config_local_toml: false, performs_network_request: false },
    }, null, 2)}\n`);
    return runDir;
  }

  for (const verb of ['status', 'verify']) {
    it(`${verb} presents a terminal 1.3 run as legacy history instead of re-judging it against the current registry`, async () => {
      const { home, cwd } = await makeHome({ satisfied: true });
      const runId = 'bootstrap-20260801T000000Z-0aa001';
      await seedTerminalPreRemovalRun(home, runId);

      const result = await boot({ argv: [verb, '--run-id', runId, '--format', 'json'], home, cwd, runner: hostedRunner(), subprocess: spySubprocess().runner });
      const report = result.report;
      // PRE-CONTROL: without the 1.3 -> 1.4 bump this branch is unreachable, because
      // legacyTerminalReport only fires on a STRICTLY older minor. If someone reverts
      // the bump, this assertion is what says so.
      strictEqual(report.historical, true, `a pre-removal terminal run is historical, not current: ${JSON.stringify(report).slice(0, 400)}`);
      strictEqual(report.legacy_schema, 'runtime-bootstrap-run-1.3');
      ok(report.not_recertified === true, 'and nothing was re-certified against the new registry');
      // The failure this prevents: re-judging would owe a proof the run can never attach.
      ok(!/configured-not-verified/.test(JSON.stringify(report.completion ?? {})),
        'the stored completion is summarized, never re-reduced into a state the run cannot leave');
    });
  }
});

describe('runtime bootstrap CLI — proof-directory entry names (§3.2)', () => {
  const SECRET = 'Bearer sk-SECRET-abc123';

  async function seedRunWithProofFiles(home, runId, files) {
    const runDir = join(home, '.agentic-plugins', 'runs', 'bootstrap', runId);
    await mkdir(join(runDir, 'proof'), { recursive: true });
    await writeFile(join(runDir, 'run.json'), `${JSON.stringify({
      schema: 'runtime-bootstrap-run-1.5',
      run_id: runId,
      started_at: '2026-07-16T00:00:00Z',
      updated_at: '2026-07-16T00:00:00Z',
      status: 'open',
      selection: { bundle: 'base', desired: ['runtime', 'companions', 'attention'], excluded: [] },
      steps: [],
      boundary: { writes_host_config: false, writes_credential: false, writes_config_local_toml: false, performs_network_request: false },
    }, null, 2)}\n`);
    for (const [name, body] of files) await writeFile(join(runDir, 'proof', name), body);
    return runDir;
  }

  it('an unrecognized entry name is located by ordinal, never quoted back into the report', async () => {
    const { home, cwd } = await makeHome({ satisfied: true });
    const runId = 'bootstrap-20260716T000000Z-0bb001';
    await seedRunWithProofFiles(home, runId, [
      [`${SECRET}.json`, '{}'],
      [`${SECRET}.txt`, 'x'],
    ]);
    const result = await boot({ argv: ['status', '--run-id', runId, '--format', 'json'], home, cwd, runner: hostedRunner(), subprocess: spySubprocess().runner });
    const serialized = JSON.stringify(result.report);
    ok(!serialized.includes('SECRET'), `an entry name must not ride out in a diagnostic:\n${serialized}`);
    // CONTROLS — the rule and the expected vocabulary must still be stated, or
    // the operator cannot rename the file.
    match(serialized, /entry\[\d\]/, 'the offending entry is still located');
    match(serialized, /expected one of deep-peer-smoke/, 'the expected kinds are still named');
  });

  it('a RECOGNIZED evidence filename is still named — the rule withholds free content, not information', async () => {
    const { home, cwd } = await makeHome({ satisfied: true });
    const runId = 'bootstrap-20260716T000000Z-0bb002';
    // `permission.json` is a name this runtime defined, so it may be quoted.
    await seedRunWithProofFiles(home, runId, [['permission.json', 'not json at all']]);
    const result = await boot({ argv: ['status', '--run-id', runId, '--format', 'json'], home, cwd, runner: hostedRunner(), subprocess: spySubprocess().runner });
    match(JSON.stringify(result.report), /permission\.json: not valid JSON/, 'a closed-vocabulary filename is information, not disclosure');
  });

  it('a parse failure reports its POSITION, never the parser message that quotes the bytes', async () => {
    const { home, cwd } = await makeHome({ satisfied: true });
    const runId = 'bootstrap-20260716T000000Z-0bb005';
    const runDir = join(home, '.agentic-plugins', 'runs', 'bootstrap', runId);
    await mkdir(runDir, { recursive: true });
    // A JSON.parse SyntaxError message embeds a snippet of the input and carries
    // no `code`, so the old `err?.code ?? err?.message` fell through to the
    // quoting message exactly when the document was the untrusted thing.
    //
    // The payload puts the marker in the FIRST BYTES on purpose: V8 truncates
    // its quotation at ten characters, so a secret further in would be hidden
    // by the truncation rather than by this fix — and the assertion below would
    // pass against the unfixed code. (Measured: `Bearer sk-SECRET-…` quotes
    // only `"Bearer sk-"...`.)
    await writeFile(join(runDir, 'run.json'), 'SECRET-sk-live-abc123 not json');
    const result = await boot({ argv: ['status', '--run-id', runId, '--format', 'json'], home, cwd, runner: hostedRunner(), subprocess: spySubprocess().runner });
    const serialized = JSON.stringify(result.report);
    ok(!serialized.includes('SECRET'), `the parser message must not ride out:\n${serialized}`);
    match(serialized, /has an unreadable manifest \(not valid JSON/, 'the failure is still named');
    match(serialized, /abandon bootstrap-20260716T000000Z-0bb005/, 'and the remedy still is');

    // The same hazard on the operator-supplied --answers file, on a clean home
    // so the broken manifest above cannot short-circuit the read.
    const fresh = await makeHome({ satisfied: true });
    const answers = join(fresh.cwd, 'answers.json');
    await writeFile(answers, 'SECRET-sk-live-xyz789 not json');
    const usage = await boot({ argv: ['plan', '--bundle', 'base', '--answers', answers], home: fresh.home, cwd: fresh.cwd, runner: hostedRunner(), subprocess: spySubprocess().runner });
    ok(!JSON.stringify(usage.report).includes('SECRET'), 'nor out of the usage path');
    match(JSON.stringify(usage.report), /--answers file is not valid JSON/);
  });

  it('an operator-supplied answer that FAILED its check is located by ordinal, never quoted back', async () => {
    // Surfaced by the cross-host Refine-verify peer: the answers file is
    // operator-authored untrusted input on the same boundary, and both its
    // failure paths echoed the offending value.
    const { home, cwd } = await makeHome({ satisfied: true });
    for (const [label, body, marker] of [
      ['answer value', '[{"step_id":"host.claude.present","answer":"PRIVATE_CANARY_ANSWER_42"}]', 'PRIVATE_CANARY_ANSWER_42'],
      ['step id', '[{"step_id":"PRIVATE_CANARY_STEP_42","answer":"accept"}]', 'PRIVATE_CANARY_STEP_42'],
    ]) {
      const answers = join(cwd, `bad-${label.replace(/ /g, '-')}.json`);
      await writeFile(answers, body);
      const result = await boot({ argv: ['plan', '--bundle', 'base', '--answers', answers], home, cwd, runner: hostedRunner(), subprocess: spySubprocess().runner });
      const serialized = JSON.stringify(result.report);
      ok(!serialized.includes(marker), `${label} must not ride out: ${serialized}`);
      match(serialized, /answers\[0\]/, `${label} is located by its position in the array`);
    }
    // CONTROLS — a MATCHED step id is a registry id this runtime declared, so
    // it stays named; and the closed answer vocabulary stays named. Withholding
    // either would cost the operator the only actionable part of the error.
    const answers = join(cwd, 'bad-answer.json');
    await writeFile(answers, '[{"step_id":"host.claude.present","answer":"PRIVATE_CANARY_ANSWER_42"}]');
    const result = await boot({ argv: ['plan', '--bundle', 'base', '--answers', answers], home, cwd, runner: hostedRunner(), subprocess: spySubprocess().runner });
    match(JSON.stringify(result.report), /for host\.claude\.present/, 'the matched registry step id is still named');
    match(JSON.stringify(result.report), /decline\|accept\|execute/, 'the expected vocabulary is still named');
    ok(!/attest-receipt/.test(JSON.stringify(result.report)), 'and the retired receipt answer is no longer offered');
  });

  it('the reported parse position comes from the PARSER, and cannot be forged by the input', async () => {
    const { home, cwd } = await makeHome({ satisfied: true });
    // V8 emits two message families and only one carries a position:
    //   `… in JSON at position 7 (line 1 column 8)`
    //   `Unexpected token 'p', "position 9"... is not valid JSON`
    // A loose /position (\d+)/ matched the second family INSIDE the quoted
    // snippet, so a file whose own text began `position 987654321` reported a
    // position it forged for itself.
    const forged = join(cwd, 'forged.json');
    await writeFile(forged, 'position 987654321 PRIVATE_CANARY_42');
    const a = await boot({ argv: ['plan', '--bundle', 'base', '--answers', forged], home, cwd, runner: hostedRunner(), subprocess: spySubprocess().runner });
    ok(!/position 9/.test(JSON.stringify(a.report).replace('is not valid JSON', '')),
      `no position may be reported for a message family that carries none: ${JSON.stringify(a.report)}`);

    // The real position is reported, and labelled in the parser's own
    // coordinates — it counts UTF-16 code units, so `é` puts the byte offset
    // one ahead of it. Claiming "byte position" here was simply wrong.
    const utf8 = join(cwd, 'utf8.json');
    await writeFile(utf8, '{"é":1 nope}');
    const b = await boot({ argv: ['plan', '--bundle', 'base', '--answers', utf8], home, cwd, runner: hostedRunner(), subprocess: spySubprocess().runner });
    match(JSON.stringify(b.report), /at input position 7, in JSON-parser coordinates/);
    strictEqual(Buffer.byteLength('{"é":1 ', 'utf8'), 8, 'the byte offset really is 8 — the position is not bytes');
  });

  it('a capped validator warning list SAYS it was capped — a bounded list must not read as the whole story', async () => {
    const { home, cwd } = await makeHome({ satisfied: true });
    const runId = 'bootstrap-20260716T000000Z-0bb004';
    const runDir = join(home, '.agentic-plugins', 'runs', 'bootstrap', runId);
    await mkdir(runDir, { recursive: true });
    // A future-minor manifest with 300 unknown scalars: the §4.1 rule forgives
    // each one with a warning, the §3.2 bound displays 16, and the operator must
    // be able to tell those 16 apart from "there were only 16". 300 rather than
    // 4,000 because the 64 KiB artifact cap would refuse the larger document
    // outright and this case would never reach the warning path at all.
    const manifest = {
      schema: 'runtime-bootstrap-run-1.9',
      run_id: runId,
      started_at: '2026-07-16T00:00:00Z',
      updated_at: '2026-07-16T00:00:00Z',
      status: 'open',
      selection: { bundle: 'base', desired: ['runtime', 'companions', 'attention'], excluded: [] },
      steps: [],
      boundary: { writes_host_config: false, writes_credential: false, writes_config_local_toml: false, performs_network_request: false },
    };
    for (let i = 0; i < 300; i += 1) manifest[`future_${i}`] = `v${i}`;
    await writeFile(join(runDir, 'run.json'), `${JSON.stringify(manifest, null, 2)}\n`);

    const result = await boot({ argv: ['status', '--run-id', runId, '--format', 'json'], home, cwd, runner: hostedRunner(), subprocess: spySubprocess().runner });
    const stated = (result.report.warnings ?? []).find((w) => /display bound/.test(w));
    ok(stated, `the omission must be stated: ${JSON.stringify(result.report.warnings)}`);
    match(stated, /300 validation warning\(s\)/, 'with the total the validator kept');
  });

  it('a flood of unreadable entries is bounded IN THE EMITTED REPORT, in both formats', async () => {
    const { home, cwd } = await makeHome({ satisfied: true });
    const runId = 'bootstrap-20260716T000000Z-0bb003';
    // 40 offending entries → 40 diagnostics → past the 32-finding report cap.
    await seedRunWithProofFiles(home, runId, Array.from({ length: 40 }, (_, i) => [`junk-${i}.txt`, 'x']));

    const json = await boot({ argv: ['status', '--run-id', runId, '--format', 'json'], home, cwd, runner: hostedRunner(), subprocess: spySubprocess().runner });
    const emitted = JSON.parse(json.rendered);
    strictEqual(emitted.diagnostics.length, REPORT_FINDINGS_MAX + 1,
      'the bound is applied to what is EMITTED, not merely available as a helper');
    match(emitted.diagnostics.at(-1), /Further findings were omitted/);
    deepStrictEqual(emitted.finding_counts, { diagnostics: 40, warnings: 0 }, 'the total stays honest');
    strictEqual(emitted.findings_omitted, true);

    // The text rendering consumes the same bounded object, so it cannot show a
    // finding the JSON dropped. Built upstream of the format branch.
    const text = await boot({ argv: ['status', '--run-id', runId], home, cwd, runner: hostedRunner(), subprocess: spySubprocess().runner });
    strictEqual(text.report.diagnostics.length, REPORT_FINDINGS_MAX + 1);
    deepStrictEqual(text.report.diagnostics, emitted.diagnostics, 'one projection feeds both renderings');
  });
});
