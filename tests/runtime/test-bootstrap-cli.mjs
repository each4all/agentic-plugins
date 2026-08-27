// tests/runtime/test-bootstrap-cli.mjs
//
// machine-bootstrap-contract.md §11.2 — the PUBLIC-SURFACE half of the test
// obligations, driven through `runBootstrap` with every dependency injected
// (probe runner, subprocess runner, home, cwd, clock, hostname). The storage
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
  projectCodexPermission,
  projectModelEffort,
  projectNotify,
  readUserGlobalCodexPermission,
  readUserGlobalModelEffort,
  readUserGlobalNotify,
  readUserGlobalRuntimeConfig,
} from '../../plugins/runtime/scripts/lib/profile-readers.mjs';
import { gatherCodexNotificationInputs } from '../../plugins/runtime/scripts/lib/notification-plan.mjs';
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
    // notify wiring + the canonical agentic-6 status_line + the canonical
    // notifications selection: all three Codex-side exact predicates must
    // observe their canonical configuration in a "satisfied" fixture
    // (notify-axis + statusline slices, and the ADR-0040 §4b approval half —
    // `notify =` carries only agent-turn-complete, so without the
    // notifications key the notify step is pending, not satisfied). ONE [tui]
    // table, matching the ONE table the combined fragment renders.
    ? `approval_policy = "on-request"\nsandbox_mode = "workspace-write"\nnotify = ["/usr/bin/env", "node", "${join(home, '.agentic-plugins', 'bin', 'codex-notify-shuttle.mjs')}"]\n[tui]\nstatus_line = ["model-with-reasoning", "git-branch", "pull-request-number", "context-used", "five-hour-limit", "weekly-limit"]\nnotifications = ["approval-requested", "agent-turn-complete"]\n`
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

// The declinable steps this fixture never satisfies from config, resolved the
// contract-shaped way — an explicit operator answer through --answers.
//
// `egress.configured` is opt-in (ADR-0041 §3a default OFF). The two Stage-4
// VALUE steps (§6.1.3) are the same shape for a different reason: a value step
// is satisfied only by a DECISION plus an observation confirming it, and a
// fixture that records no decision leaves them pending forever — which is the
// interview working, not a defect. Declining is the terse fixture answer; the
// value paths get their own tests rather than riding in every unrelated one.
async function writeEgressDecline(home) {
  const path = join(home, 'egress-decline.json');
  await writeFile(path, JSON.stringify([
    { step_id: 'egress.configured', answer: 'decline' },
    { step_id: 'config.session', answer: 'decline' },
    { step_id: 'config.notify_kinds', answer: 'decline' },
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
    // renders as `not-applicable (declined)`, and a declined row is one of the
    // three provenances that opt the egress proof in (§8.1). The first cut of
    // this fix refused the whole status and deleted that path; four existing
    // presentation/opt-in cases caught it.
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

  it('C1 — a plan-time execute on the egress proof survives: the promotion runs BEFORE the grammar', async () => {
    // The critical constraint, pinned explicitly. Any answer naming
    // proof.egress-provider-ack promotes it to applicable (§8.1) and that
    // derivation happens before judgement, so the grammar never meets the step
    // as `not-applicable`. This also refutes the follow-up's premise that a
    // plan-mode `execute` is inert: for THIS step it is the opt-in itself, and
    // a verb restriction on `execute` would have deleted the plan → resume
    // egress path.
    const { home, cwd } = await makeHome();
    const file = join(home, 'egress-opt-in.json');
    await writeFile(file, JSON.stringify([{ step_id: 'proof.egress-provider-ack', answer: 'execute' }]));
    const res = await boot({ argv: ['plan', '--bundle', 'base', '--answers', file, '--format', 'json'], home, cwd, runner: bareRunner(), subprocess: spySubprocess().runner });
    notStrictEqual(res.exitCode, EXIT.INVALID, 'the opt-in must not be refused as inert');
    const row = res.report.steps.find((s) => s.id === 'proof.egress-provider-ack');
    notStrictEqual(row.status, 'not-applicable', 'the answer promoted it before the grammar saw it');
    const egress = res.report.completion.proofs.find((pr) => pr.kind === 'egress-provider-ack');
    strictEqual(egress.required, true, 'and the opt-in is what makes it owed');
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

  it('C1 — a plan-time execute nothing will consume is refused, and the egress opt-in is the one exception', async () => {
    // Measured, and it corrected this fix's own first draft: `resume` builds its
    // execute set from its OWN answers file, so a plan-time `execute` on an
    // ordinary proof is recorded and then never acted on (the bare resume left
    // deep-peer-smoke `absent` with no warning and no doctor call). The egress
    // ack is different in kind: any answer naming it promotes it and lands in
    // choices[], which IS the §8.1 opt-in the reducer reads.
    const { home, cwd } = await makeHome();
    const run = (argv) => boot({ argv, home, cwd, runner: hostedRunner(), subprocess: spySubprocess().runner });
    const inert = join(home, 'plan-exec-inert.json');
    await writeFile(inert, JSON.stringify([{ step_id: 'proof.deep-peer-smoke', answer: 'execute' }]));
    const refused = await run(['plan', '--bundle', 'base', '--answers', inert]);
    strictEqual(refused.exitCode, EXIT.INVALID);
    ok(/not acted on under plan/.test(refused.report.error), refused.report.error);

    const optIn = join(home, 'plan-exec-egress.json');
    await writeFile(optIn, JSON.stringify([{ step_id: 'proof.egress-provider-ack', answer: 'execute' }]));
    const allowed = await run(['plan', '--bundle', 'base', '--answers', optIn, '--format', 'json']);
    notStrictEqual(allowed.exitCode, EXIT.INVALID, 'the egress opt-in must survive');
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

  it('C1 — the resume that first observes the applied fragment can execute proof.permission', async () => {
    // `fragment_applied` is PROMOTED by the judgement, while the expectation was
    // derived from the value stored BEFORE it — so proof.permission derived
    // applicable:false on the very resume that earned it. That cost a silent
    // extra cycle before, and became exit 40 once applicability was a refusal.
    const { home, cwd } = await makeHome();
    const run = (argv) => boot({ argv, home, cwd, runner: hostedRunner(), subprocess: spySubprocess().runner });
    const plan = await run(['plan', '--bundle', 'base', '--format', 'json']);
    // Fixture precondition: the fragments are RENDERED and not yet applied, or
    // the assertion below would hold for the wrong reason.
    for (const host of ['claude', 'codex']) {
      const row = plan.report.steps.find((s) => s.id === `permission.${host}.applied`);
      strictEqual(row.status, 'pending', `${host} fragment is rendered, not applied`);
      strictEqual(row.fragment_applied, false);
    }
    strictEqual(plan.report.steps.find((s) => s.id === 'proof.permission').status, 'not-applicable');

    await writeFile(join(home, '.claude', 'settings.json'), `${JSON.stringify({ permissions: { defaultMode: 'acceptEdits', allow: ['Read'] } }, null, 2)}\n`);
    await writeFile(join(home, '.codex', 'config.toml'), 'approval_policy = "on-request"\nsandbox_mode = "workspace-write"\n');
    const exec = join(home, 'execute-permission.json');
    await writeFile(exec, JSON.stringify([{ step_id: 'proof.permission', answer: 'execute' }]));
    const res = await run(['resume', '--latest-open', '--answers', exec, '--format', 'json']);
    notStrictEqual(res.exitCode, EXIT.INVALID, `the same resume that applies the fragment may prove it: ${res.report?.error}`);
    strictEqual(res.report.steps.find((s) => s.id === 'proof.permission').status, 'pending',
      'the re-derivation makes it applicable in THIS verb, not the next one');
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

  it('profile export refuses a secret-bearing permission rule — the RAW readers reach the gate, not the sanitized profile', async () => {
    // A CLI-LEVEL test on purpose. The defect was in the WIRING, not the guard:
    // `assertProfileWritable` always refused a secret-shaped source, but the export
    // handed it `buildMachineProfile`'s OUTPUT as `original`, and the builder
    // sanitizes permission rules on the way in. So the scrub inspected the
    // sanitizer's own output and passed. A unit test on the guard passes with the
    // defect present and pins nothing; only driving the real export can see it.
    const { home, cwd } = await makeHome({ satisfied: true });
    const run = (argv) => boot({ argv, home, cwd, runner: satisfiedRunner(), subprocess: spySubprocess().runner });

    // Plant a bearer token where the builder is known to sanitize.
    await writeFile(join(home, '.claude', 'settings.json'), `${JSON.stringify({
      permissions: {
        defaultMode: 'acceptEdits',
        allow: ['Bash(curl -H "Authorization: Bearer sk-live-abcdef0123456789abcdef0123456789")'],
      },
    }, null, 2)}\n`);

    const refused = await run(['profile', 'export', '--name', 'leaky']);
    strictEqual(refused.exitCode, EXIT.INVALID, 'a secret-shaped source refuses the write');
    ok(
      JSON.stringify(refused.report).includes('secret-shaped'),
      `the refusal names the reason: ${JSON.stringify(refused.report).slice(0, 300)}`,
    );
    // And nothing landed — a refused profile must not be on disk.
    await rejects(() => readFile(join(home, '.agentic-plugins', 'profiles', 'leaky.json'), 'utf8'));

    // CONTROL: the same export with clean readers still writes. Without this the
    // assertion above would also pass if export were broken for every input.
    await writeFile(join(home, '.claude', 'settings.json'), `${JSON.stringify({
      permissions: { defaultMode: 'acceptEdits', allow: ['Read'] },
    }, null, 2)}\n`);
    const ok2 = await run(['profile', 'export', '--name', 'clean']);
    strictEqual(ok2.exitCode, EXIT.OK, 'a clean source still exports');
    ok(JSON.parse(await readFile(join(home, '.agentic-plugins', 'profiles', 'clean.json'), 'utf8')).schema.startsWith('agentic-machine-profile-'));
  });

  it('export is NOT gated on reader data the profile never carries', async () => {
    // The over-correction control. `readers` also holds statuslineClaude /
    // statuslineCodex / codexNotify / egressActivation — read for JUDGEMENT, never
    // projected — and projectClaudeStatusline documents its raw command as possibly
    // carrying secrets. Gating on the whole bundle refused exports over values the
    // profile provably cannot contain (both review lanes, reproduced).
    const { home, cwd } = await makeHome({ satisfied: true });
    const run = (argv) => boot({ argv, home, cwd, runner: satisfiedRunner(), subprocess: spySubprocess().runner });

    const settings = JSON.parse(await readFile(join(home, '.claude', 'settings.json'), 'utf8'));
    settings.statusLine = { type: 'command', command: 'node /opt/sl.mjs --key sk-ant-abcdefghijklmnopqrstuvwx' };
    await writeFile(join(home, '.claude', 'settings.json'), `${JSON.stringify(settings, null, 2)}\n`);

    const exported = await run(['profile', 'export', '--name', 'statusline-secret']);
    strictEqual(exported.exitCode, EXIT.OK, `a secret in a NON-exported subtree must not block the write: ${JSON.stringify(exported.report).slice(0, 240)}`);
    ok(!JSON.stringify(JSON.parse(await readFile(join(home, '.agentic-plugins', 'profiles', 'statusline-secret.json'), 'utf8'))).includes('sk-ant-'), 'and the secret is nowhere in the artifact');
  });

  it('a laundered permission rule is refused, and the diagnostic names THAT field exactly', async () => {
    // The narrowing must not weaken the guard it exists for. Asserting the exact
    // locator is the point: a bare "contains secret-shaped" assertion would also be
    // satisfied by some unrelated reader field failing, which is how a too-wide
    // source passed review once already.
    const { home, cwd } = await makeHome({ satisfied: true });
    const run = (argv) => boot({ argv, home, cwd, runner: satisfiedRunner(), subprocess: spySubprocess().runner });
    await writeFile(join(home, '.claude', 'settings.json'), `${JSON.stringify({
      permissions: { defaultMode: 'acceptEdits', allow: ['Bash(curl -H "Authorization: Bearer sk-live-abcdef0123456789abcdef0123456789")'] },
    }, null, 2)}\n`);

    const refused = await run(['profile', 'export', '--name', 'leaky2']);
    strictEqual(refused.exitCode, EXIT.INVALID);
    const text = JSON.stringify(refused.report);
    ok(text.includes('$.claudePermission.allow[0]'), `the refusal names the lossy field exactly: ${text.slice(0, 300)}`);
    await rejects(() => readFile(join(home, '.agentic-plugins', 'profiles', 'leaky2.json'), 'utf8'));
  });

  it('a benign PII-shaped rule is SANITIZED into the profile, not refused', async () => {
    // §4.1 says permission arrays are "sanitized through permission-sanitize.mjs".
    // Refusing on the sanitizer's own detector made that unreachable and turned an
    // email or a git sha into a hard refusal.
    const { home, cwd } = await makeHome({ satisfied: true });
    const run = (argv) => boot({ argv, home, cwd, runner: satisfiedRunner(), subprocess: spySubprocess().runner });
    await writeFile(join(home, '.claude', 'settings.json'), `${JSON.stringify({
      permissions: { defaultMode: 'acceptEdits', allow: ['Bash(git commit --author=ada@example.com:*)', 'Bash(git show 1234567890abcdef1234567890abcdef12345678:*)'] },
    }, null, 2)}\n`);

    const exported = await run(['profile', 'export', '--name', 'benign']);
    strictEqual(exported.exitCode, EXIT.OK, `benign PII-shaped rules export: ${JSON.stringify(exported.report).slice(0, 240)}`);
    const rules = JSON.parse(await readFile(join(home, '.agentic-plugins', 'profiles', 'benign.json'), 'utf8')).permissions.claude.allow;
    ok(rules.some((r) => r.includes('<redacted-email>')), `the email is redacted, not exported: ${JSON.stringify(rules)}`);
    ok(rules.some((r) => r.includes('<redacted-hex>')), `the sha is redacted: ${JSON.stringify(rules)}`);
    ok(!JSON.stringify(rules).includes('ada@example.com'), 'and the raw address never reaches the artifact');
  });

  it('#4 + #30 — profile export → seed round-trips (id + hash recorded); overwrite is refused without --overwrite; path traversal is refused', async () => {
    const { home, cwd } = await makeHome({ satisfied: true });
    const spy = spySubprocess();
    const run = (argv) => boot({ argv, home, cwd, runner: satisfiedRunner(), subprocess: spy.runner });

    // Profile 1.2 — give this home a session-family posture so the export path is
    // exercised end-to-end rather than only in the unit tests. Written here rather
    // than in the shared fixture so the other 150 cases keep their exact bytes.
    await writeFile(
      join(home, '.agentic-plugins', 'config.toml'),
      'model = "gpt-5.2-codex"\neffort = "high"\nnotify_channel = "file-log"\nsession_capture = "stop-hook"\nentry_brief = "startup"\n',
    );

    const exported = await run(['profile', 'export', '--name', 'machine-a']);
    strictEqual(exported.exitCode, EXIT.OK);
    const profilePath = join(home, '.agentic-plugins', 'profiles', 'machine-a.json');
    const profile = JSON.parse(await readFile(profilePath, 'utf8'));
    strictEqual(profile.schema, 'agentic-machine-profile-1.2');
    ok(Object.values(profile.boundary).every((flag) => flag === false), 'every boundary flag is false');
    // The session family survives the real CLI read → build → write-gate → disk
    // path, and an UNSET member lands as null rather than vanishing.
    strictEqual(profile.session_capture, 'stop-hook');
    strictEqual(profile.entry_brief, 'startup');
    strictEqual(profile.entry_brief_empty, null);
    // The bytes on disk ARE the canonical form — asserted against the canonicalizer
    // itself, not against a literal key list. A literal list here would be a third
    // copy of an ordering fact the schema and PROFILE_SESSION_KEYS already state
    // twice, and a mirror that can drift is what this whole area keeps getting
    // wrong (cross-host review). This phrasing also pins the real invariant: the
    // written file is what `profileHash` hashed, rather than merely happening to
    // share its order.
    const { canonicalProfile } = await import('../../plugins/runtime/scripts/lib/machine-profile.mjs');
    const { loadSchema } = await import('../../plugins/runtime/scripts/lib/schema-validate.mjs');
    const profileSchema = await loadSchema('agentic-machine-profile');
    deepStrictEqual(
      Object.keys(profile),
      Object.keys(canonicalProfile(profile, profileSchema)),
      `written bytes are canonical: ${Object.keys(profile).join(',')}`,
    );
    // …and the session family really is at the end of it, which is the property the
    // cross-minor alignment depends on.
    ok(
      Object.keys(profile).slice(-3).every((k) => ['entry_brief', 'entry_brief_empty', 'session_capture'].includes(k)),
      `session scalars trail: ${Object.keys(profile).join(',')}`,
    );

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

  it('profile export / seed RENDER what they computed, in both formats', async () => {
    // These two were the only verbs whose output was strictly less than what
    // they computed: no `--format json` door, and a text render that dropped
    // the export pointer, the export hash, and every §4.5 seed proposal and
    // safety-graded note. §4.5 items 3 and 4 are PRESENTATION obligations, so
    // computing them correctly and rendering nothing left the contract unmet
    // and the skill's own "unsafe source values arrive as labelled notes"
    // true of the computation and false of anything the operator could see.
    const { home, cwd } = await makeHome({ satisfied: true });
    const spy = spySubprocess();
    const run = (argv) => boot({ argv, home, cwd, runner: satisfiedRunner(), subprocess: spy.runner });

    const exported = await run(['profile', 'export', '--name', 'machine-r', '--format', 'json']);
    strictEqual(exported.exitCode, EXIT.OK, '--format is part of the grammar now');
    const profilePath = join(home, '.agentic-plugins', 'profiles', 'machine-r.json');

    const exportText = renderText(exported.report);
    ok(exportText.includes(exported.report.pointer), `the pointer reaches the operator:\n${exportText}`);
    ok(exportText.includes(exported.report.hash), `and so does the hash:\n${exportText}`);
    ok(/^- profile: machine-r$/m.test(exportText), 'and the name it was written under');

    const answers = await writeEgressDecline(home);
    strictEqual((await run(['plan', '--bundle', 'base', '--answers', answers])).exitCode, EXIT.CONFIGURED_NOT_VERIFIED);
    const seeded = await run(['profile', 'seed', '--profile-file', profilePath, '--format', 'json']);
    strictEqual(seeded.exitCode, EXIT.OK, 'seed accepts --format too');

    const seedText = renderText(seeded.report);
    ok(/^- seeded from: machine-r \(/m.test(seedText), `the seed linkage renders:\n${seedText}`);
    // Guard the loop below against passing vacuously on an empty list — the
    // whole assertion is "every proposal is presented", which says nothing if
    // there are none (Refine-verify peer, MINOR).
    ok(seeded.report.proposals.proposals.length > 0, 'the fixture must actually produce proposals for this to assert anything');
    for (const proposal of seeded.report.proposals.proposals) {
      ok(seedText.includes(proposal.key), `proposal ${proposal.key} is presented:\n${seedText}`);
    }
    ok(/default \(confirm\)/.test(seedText), 'and presented AS a default requiring confirmation (§4.5 item 4)');

    strictEqual((await run(['abandon', '--latest-open'])).exitCode, EXIT.OK);
  });

  it('an UNCLAMPED proposal value never crosses artifact -> report — §3.2, in JSON as well as text', async () => {
    // REWRITTEN. The previous version drove `renderText` with a hand-built
    // report object, which measured the RENDERER — and the renderer was never
    // the whole boundary: `--format json` serializes the report OBJECT, so a
    // raw `proposals[].value` crossed there no matter what the text path did
    // (cross-host review, MAJOR — "the §3.2 regression test exercises renderText
    // only, which is why that door stayed open unnoticed"). Disclosure now
    // happens at report-BUILD time, so the test drives the real verbs and reads
    // BOTH surfaces.
    const { home, cwd } = await makeHome({ satisfied: true });
    // Private markers in keys with NO validator: `model` is a free string and
    // the Claude permission rules are a free array — exactly the class §3.2's
    // threat model is about, and the class the old renderer-only test could not
    // protect in `--format json`.
    await writeFile(join(home, '.agentic-plugins', 'config.toml'), 'model = "PRIVATE-MARKER-ALPHA"\neffort = "high"\n');
    await writeFile(join(home, '.claude', 'settings.json'), `${JSON.stringify({
      permissions: { defaultMode: 'acceptEdits', allow: ['Bash(PRIVATE-RULE-BRAVO)'] },
      statusLine: { type: 'command', command: `node '${join(home, '.agentic-plugins', 'bin', 'agentic-statusline.mjs').replace(/\\/g, '/')}'` },
    }, null, 2)}\n`);
    const run = (argv) => boot({ argv, home, cwd, runner: hostedRunner(), subprocess: spySubprocess().runner });

    await run(['plan', '--bundle', 'base', '--format', 'json']);
    const exported = await run(['profile', 'export', '--name', 'leak', '--format', 'json']);
    strictEqual(exported.exitCode, 0, 'precondition: a profile was exported');
    const profilePath = join(home, '.agentic-plugins', 'profiles', 'leak.json');
    const artifact = await readFile(profilePath, 'utf8');
    for (const marker of ['PRIVATE-MARKER-ALPHA', 'PRIVATE-RULE-BRAVO']) {
      ok(artifact.includes(marker),
        `precondition: the ARTIFACT does carry ${marker} — the boundary is artifact -> report, not artifact -> disk`);
    }

    // Both entry points that present proposals, on both surfaces. `profile seed`
    // needs the open run; `plan` refuses while one is open, so the run is closed
    // between them.
    const seeded = await run(['profile', 'seed', '--profile-file', profilePath, '--format', 'json']);
    await run(['abandon', '--latest-open', '--reason', 'test']);
    const planned = await run(['plan', '--bundle', 'base', '--profile-file', profilePath, '--format', 'json']);
    for (const [label, result] of [['profile seed', seeded], ['plan --profile-file', planned]]) {
      ok(result.report.proposals, `${label}: presents proposals at all (the plan half is the new door)`);
      // Scoped to the PROPOSALS boundary, which is what this change owns.
      // Deliberately NOT asserted over the whole report: `config.model_effort`'s
      // judge interpolates its raw coordinate values into `steps[].observed`,
      // which is the same §3.2 class in PRE-EXISTING code this change does not
      // touch. Widening the assertion here would either fail on that unrelated
      // leak or quietly pressure this change into redefining an unrelated
      // judge's disclosure policy — a decision with a real diagnostic cost
      // (`model=claude-opus-5` would stop being readable), recorded rather than
      // absorbed. See docs/follow-ups.md.
      const serialized = JSON.stringify(result.report.proposals);
      for (const marker of ['PRIVATE-MARKER-ALPHA', 'PRIVATE-RULE-BRAVO']) {
        ok(!serialized.includes(marker), `${label}: ${marker} must not cross in the proposal list`);
      }
      ok(!result.rendered.split('\n').filter((line) => /default \(confirm\)/.test(line)).join('\n').includes('PRIVATE-'),
        `${label}: nor on the rendered proposal lines`);
      const model = result.report.proposals.proposals.find((entry) => entry.key === 'model_effort.model');
      ok(model && model.value_disclosed === false, `${label}: the withholding is recorded, not just performed`);
      match(model.value, /chars — /, `${label}: and what crosses instead is type + length`);
    }
  });

  it('a GRAMMAR-CLAMPED proposal value DOES cross — §3.2 keys on the schema, not on caution', () => {
    // The control for the test above: withholding is decided per field, so a
    // value this runtime's own validators accept is named rather than reduced
    // to a length. A blanket "withhold every string" would pass the test above
    // and fail this one.
    const text = renderText({
      verb: 'profile seed',
      run_id: 'run-x',
      status: 'seeded',
      seeded_from: { profile_id: 'm', profile_hash: 'a'.repeat(64) },
      proposals: {
        ok: true,
        refused: [],
        proposals: [
          // Post-sanitize shapes, which is what the renderer now receives.
          { key: 'session.entry_brief', value: 'startup', value_disclosed: true, scope: 'machine' },
          { key: 'permissions.claude.allow', value: '<2 entries, 36 chars — withheld per §3.2>', value_disclosed: false, scope: 'machine' },
        ],
        notes: [],
        boundary: {},
      },
      warnings: [],
      diagnostics: [],
    });
    ok(/session\.entry_brief = startup/.test(text), `a clamped enum is named:\n${text}`);
    ok(/permissions\.claude\.allow = <2 entries, /.test(text), 'an unclamped array still reports count and width');
  });

  it('a safety-graded note is what the operator actually SEES, not just what seed computed', async () => {
    // §4.5 item 3 with teeth: an unsafe source posture must reach the operator
    // as a labelled note. The grading was already correct; the render dropped
    // it, so the one rule the contract says has teeth had none at the boundary
    // where it matters.
    const text = renderText({
      verb: 'profile seed',
      run_id: 'run-x',
      seeded_from: { profile_id: 'machine-a', profile_hash: 'a'.repeat(64) },
      status: 'seeded',
      proposals: {
        ok: true,
        refused: [],
        proposals: [],
        notes: [{
          key: 'permissions.claude.defaultMode',
          note: "The source machine used 'bypassPermissions'. Not proposed as a default: the target's safe recommendation wins.",
          labelled: 'unsafe-posture-not-proposed',
          source_value: 'bypassPermissions',
          proposed_instead: 'acceptEdits',
        }],
        boundary: { writes_host_config: false, applies_nothing: true, re_diagnoses_target: true },
      },
      warnings: [],
      diagnostics: [],
    });
    ok(/unsafe-posture-not-proposed/.test(text), `the note is labelled as such:\n${text}`);
    ok(/permissions\.claude\.defaultMode/.test(text), 'and names the key it is about');
    ok(/bypassPermissions/.test(text), 'and shows the source value it refused to propose');
    ok(!/default \(confirm\): permissions\.claude\.defaultMode/.test(text),
      'and is never rendered as a default — the whole point of grading it');
  });

  it('a refusal renders its reason in text, not only in JSON', async () => {
    // `reason` is set by `profile export` and by `abandon`, and both pair it
    // with a `diagnostics` list that can be empty — leaving a text-mode
    // operator holding "refused" and no cause.
    const text = renderText({ verb: 'profile export', name: 'x', status: 'refused', reason: 'profile-exists', diagnostics: [] });
    ok(/^- reason: profile-exists$/m.test(text), `the cause reaches text mode:\n${text}`);
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
      schema: 'runtime-bootstrap-run-1.3',
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

  it('refuses a legacy-schema run — attest records CURRENT-schema evidence only', async () => {
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
    await writeFile(optIn, JSON.stringify([
      { step_id: 'proof.egress-provider-ack', answer: 'execute' },
      // §6.1.3 — the two Stage-4 value steps are CONFIG obligations like any
      // other; a run that never resolves them cannot terminalize, which is the
      // interview doing its job. Declining is this fixture's answer because its
      // subject is the receipt door, not the value grammar.
      { step_id: 'config.session', answer: 'decline' },
      { step_id: 'config.notify_kinds', answer: 'decline' },
    ]));
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
    // The notify step fully configured (BOTH halves — argv + the ADR-0040 §4b
    // notifications selection) while the statusline step is not: no
    // `status_line` key. A satisfied notify step skips fragment persistence, so
    // no notify artifact freezes on this plan run — which is the precondition
    // this test needs. Configuring only the argv would leave the step pending,
    // freeze a STRIPPED artifact here, and turn the scenario into the §6.1.1
    // no-source case that the rounds-5-6 test below already covers.
    const notifyConfigured = `approval_policy = "on-request"\nsandbox_mode = "workspace-write"\nnotify = ["/usr/bin/env", "node", "${join(home, '.agentic-plugins', 'bin', 'codex-notify-shuttle.mjs')}"]\n[tui]\nnotifications = ["approval-requested", "agent-turn-complete"]\n`;
    await writeFile(codexConfig, notifyConfigured);
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
    strictEqual(migrated.schema, 'runtime-bootstrap-run-1.3', 'the schema stamp is bumped explicitly (the old spread preserved 1.1)');
    ok(migrated.history.some((h) => h.from === 'runtime-bootstrap-run-1.1' && h.to === 'runtime-bootstrap-run-1.3'), 'the migration is a history row, not a silent rewrite');
    // Registry-new steps joined the persisted run (the 1.1 world had no notify.codex.configured).
    ok(migrated.steps.some((s) => s.id === 'notify.codex.configured'), 'the ADR-0048 §1 split step was injected additively');
    // The satisfied fixture wires notify=, so the injected step judged satisfied on the same resume.
    strictEqual(migrated.steps.find((s) => s.id === 'notify.codex.configured').status, 'satisfied');
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
            // A blocked egress executor is what runtime:doctor exits
            // PROOF_INCOMPLETE (20) for — it is a requested proof that produced
            // no verdict. The stub carries the real code so this fixture keeps
            // describing a report doctor can actually emit; the import must
            // still read it, which is the property being pinned.
            return { ...okOut(JSON.stringify({
              egress_ack_proof: {
                requested: true, executed: false, mode: 'explicit_egress_executor', status: 'blocked',
                provider_ack: null, outcome_reason: null, mirror_correlated: false, network_request_performed: false,
                blockers: ['AGENTIC_EGRESS_REAL_SMOKE=1 is not set — the real-network send needs this third consent alongside the two flags (export it in the shell that runs the executor)'],
                limits: [],
              },
              doctor_artifact: { artifact_pointer: '~/.agentic-plugins/runs/doctor/stub/doctor.json', artifact_sha256: ARTIFACT_SHA },
            })), ok: false, exit_code: 20 };
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

  // A PASSED proof can still carry a WAL warning: the provider acked and the
  // mirror correlated — which is exactly what `passed` asserts — while the intent
  // record that fences the NEXT attempt was not written durably. The import only
  // forwarded diagnostics when it FAILED, so on the success path the warning died
  // inside bootstrap and the operator was never told the fence may not survive a
  // reboot (peer round-3 MAJOR: reporting nobody reads is not reporting).
  it('resume surfaces a PASSED proof\'s intent-WAL warning instead of swallowing it', async () => {
    const { home, cwd } = await makeHome({ satisfied: true });
    const base = egressDoctorStub();
    const runner = async (scriptPath, args) => {
      const out = await base.runner(scriptPath, args);
      if (scriptPath.endsWith('doctor.mjs') && args.includes('--execute-egress-ack-proof')) {
        const report = JSON.parse(out.stdout);
        report.egress_ack_proof.wal_durability = 'failed';
        report.egress_ack_proof.limits = ['the intent WAL could not be updated durably (write-failed, phase=pre-publish, published=false). The provider outcome above stands; could not stage the terminal record for fp.json (EACCES).'];
        report.overall = { warnings: ['egress intent WAL failed — the provider outcome stands, but the fence for a future attempt may not (see egress_ack_proof.limits)'] };
        return okOut(JSON.stringify(report));
      }
      return out;
    };
    const run = (argv) => boot({ argv, home, cwd, runner: hostedRunner(), subprocess: runner, env: EGRESS_ENV });
    const plan = await run(['plan', '--bundle', 'base', '--format', 'json']);
    const answersPath = join(home, 'execute-egress-wal.json');
    await writeFile(answersPath, JSON.stringify([{ step_id: 'proof.egress-provider-ack', answer: 'execute' }]));
    const resume = await run(['resume', '--latest-open', '--answers', answersPath]);

    const warnings = (resume.report.warnings ?? []).join(' ');
    ok(/intent WAL/i.test(warnings), `the WAL warning must survive a PASSED proof: ${JSON.stringify(resume.report.warnings)}`);
    ok(/egress-provider-ack/.test(warnings), `and name the proof it belongs to: ${warnings}`);
    // Control: the proof itself still imported — the warning is additional
    // information, never a downgrade of an independently true provider fact.
    const proofPath = join(home, '.agentic-plugins', 'runs', 'bootstrap', plan.report.run_id, 'proof', 'egress-provider-ack.json');
    strictEqual(JSON.parse(await readFile(proofPath, 'utf8')).provider_ack.result, 'acked');
  });

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
    const path = join(home, 'execute-smoke-and-decline-egress.json');
    await writeFile(path, JSON.stringify([
      { step_id: 'proof.deep-peer-smoke', answer: 'execute' },
      { step_id: 'egress.configured', answer: 'decline' },
      { step_id: 'config.session', answer: 'decline' },
      { step_id: 'config.notify_kinds', answer: 'decline' },
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

  it('applicability moves with the snapshot: a permission fragment applied DURING the proof makes proof.permission applicable in the same resume', async () => {
    // The executor-induced applicability edge: `fragment_applied` is promoted
    // the first time a rendered fragment is observed applied, and
    // deriveExpectedSteps reads it to decide whether proof.permission exists at
    // all. Observed for the first time in the FINAL snapshot, it must reach the
    // expectation the reconstruction is built from — a reconstruction that
    // reused the pre-execution expectation would rebuild the run around an
    // applicability its own snapshot disproves.
    const { home, cwd } = await makeHome();
    const state = { installed: [...ALL_PLUGINS], hosts: ['claude', 'codex'] };
    const run = (argv, subprocess) => boot({ argv, home, cwd, runner: mutableRunner(state), subprocess });

    const plan = await run(['plan', '--bundle', 'base', '--format', 'json'], spySubprocess().runner);
    const runId = plan.report.run_id;
    // CONTROL, both halves: the fragment must be RENDERED (promotion requires a
    // prior pointer) and the proof must start non-applicable, or the assertion
    // below would hold with or without the reconstruction.
    const plannedPermission = plan.report.steps.find((s) => s.id === 'permission.claude.applied');
    strictEqual(plannedPermission?.status, 'pending', 'precondition: the permission step is unresolved at plan time');
    ok(plannedPermission?.fragment_pointer, 'precondition: a permission fragment was rendered, so fragment_applied can be promoted later');
    strictEqual(plan.report.steps.find((s) => s.id === 'proof.permission')?.status, 'not-applicable',
      'precondition: with no fragment applied, the permission proof does not apply');

    // The operator applies the Claude permission fragment while the smoke runs.
    const resume = await run(
      ['resume', '--latest-open', '--answers', await writeSmokeAnswers(home)],
      smokeDoctorStub(async () => {
        await writeFile(join(home, '.claude', 'settings.json'),
          `${JSON.stringify({ permissions: { defaultMode: 'acceptEdits', allow: ['Read'] } }, null, 2)}\n`);
      }),
    );

    const permissionRow = resume.report.steps.find((s) => s.id === 'permission.claude.applied');
    strictEqual(permissionRow?.status, 'satisfied',
      `the mid-proof application is observed by the final readers (got ${permissionRow?.status})`);
    strictEqual(permissionRow?.fragment_applied, true, 'and promoted, which is what the expectation reads');
    const proofRow = resume.report.steps.find((s) => s.id === 'proof.permission');
    ok(proofRow && proofRow.status !== 'not-applicable',
      `the expectation is re-derived from the final snapshot, so the proof applies in THIS resume (got ${proofRow?.status})`);
    const persisted = (await manifestOf(home, runId)).steps.find((s) => s.id === 'proof.permission');
    ok(persisted && persisted.status !== 'not-applicable',
      `and the run persists that applicability rather than making the operator resume twice (got ${persisted?.status})`);
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
      { step_id: 'egress.configured', answer: 'decline' },
      { step_id: 'config.session', answer: 'decline' },
      { step_id: 'config.notify_kinds', answer: 'decline' },
      { step_id: 'proof.deep-peer-smoke', answer: 'execute' },
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
      { step_id: 'egress.configured', answer: 'decline' },
      { step_id: 'config.session', answer: 'decline' },
      { step_id: 'config.notify_kinds', answer: 'decline' },
      { step_id: 'proof.deep-peer-smoke', answer: 'execute' },
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
      { step_id: 'egress.configured', answer: 'decline' },
      { step_id: 'config.session', answer: 'decline' },
      { step_id: 'config.notify_kinds', answer: 'decline' },
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
      { step_id: 'egress.configured', answer: 'decline' },
      { step_id: 'config.session', answer: 'decline' },
      { step_id: 'config.notify_kinds', answer: 'decline' },
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
      { step_id: 'egress.configured', answer: 'decline' },
      { step_id: 'config.session', answer: 'decline' },
      { step_id: 'config.notify_kinds', answer: 'decline' },
      { step_id: 'proof.deep-peer-smoke', answer: 'execute' },
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
    // reports a proof `blocked` behind a predecessor the same report shows
    // `declined`, and an immediate status reports it `pending`.
    const { home, cwd } = await makeHome({ satisfied: true });
    const state = { hosts: ['claude', 'codex'], installed: [...ALL_PLUGINS] };
    const run = (argv) => boot({ argv, home, cwd, runner: mutableRunner(state), subprocess: spySubprocess().runner });
    await run(['plan', '--bundle', 'base', '--format', 'json']);

    const answersPath = join(home, 'accept-proof-decline-predecessor.json');
    await writeFile(answersPath, JSON.stringify([
      { step_id: 'proof.egress-provider-ack', answer: 'accept' },
      { step_id: 'egress.configured', answer: 'decline' },
      { step_id: 'config.session', answer: 'decline' },
      { step_id: 'config.notify_kinds', answer: 'decline' },
    ]));
    const resume = await run(['resume', '--latest-open', '--answers', answersPath]);
    // CONTROL: no child ran, so this is the no-snapshot-movement path — the one
    // the old gate skipped.
    strictEqual(resume.report.steps.find((s) => s.id === 'egress.configured')?.status, 'declined',
      'precondition: the predecessor is resolved by this resume\'s own answer');

    const status = await run(['status', '--format', 'json']);
    const resumeRow = resume.report.steps.find((s) => s.id === 'proof.egress-provider-ack');
    const statusRow = status.report.steps.find((s) => s.id === 'proof.egress-provider-ack');
    strictEqual(resumeRow?.status, statusRow?.status,
      `resume and status must agree about the row (resume=${resumeRow?.status}, status=${statusRow?.status})`);
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
    await writeFile(answersPath, JSON.stringify([{ step_id: 'egress.configured', answer: 'decline' }, { step_id: 'config.session', answer: 'decline' }, { step_id: 'config.notify_kinds', answer: 'decline' }]));
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

// The one verb that deliberately does NOT converge (§7, owner decision
// 2026-08-02). Its subject is a send that already happened, so a selection that
// lapsed after the run closed must not refuse testimony about it — and the
// resulting divergence from `status` must be stated, not silent.
describe('bootstrap attest — the receipt door judges the run as it was reduced', () => {
  const EGRESS_ENV = { AGENTIC_NOTIFY_EGRESS_CHANNEL: 'telegram', TELEGRAM_BOT_TOKEN: '999999:sentinel' };
  const RECIPIENT = '424242424242';

  async function completedRunWithPassedAck() {
    const { home, cwd } = await makeHome({ satisfied: true });
    await writeFile(join(home, '.agentic-plugins', 'config.local.toml'), `egress_chat_id = "${RECIPIENT}"\n`, { mode: 0o600 });
    const state = {
      hosts: ['claude', 'codex'],
      claude: [...ALL_PLUGINS],
      codex: ALL_PLUGINS.filter((p) => p !== 'designer'),
    };
    const fingerprint = deriveActivationFingerprint({ channel: 'telegram', recipient: RECIPIENT, credentialEnvVar: 'TELEGRAM_BOT_TOKEN' });
    const subprocess = async (scriptPath, args) => {
      if (scriptPath.endsWith('settings.mjs')) return okOut(JSON.stringify({ plugin_management: { plan_hash: null } }));
      if (scriptPath.endsWith('doctor.mjs')) {
        if (args.includes('--execute-egress-ack-proof')) {
          return okOut(JSON.stringify({
            egress_ack_proof: {
              requested: true, executed: true, mode: 'explicit_egress_executor', status: 'passed',
              provider_ack: { result: 'acked', attempt_hash: 'a'.repeat(64), activation_fingerprint: fingerprint, ran_at: '2026-07-18T04:00:00.000Z' },
              outcome_reason: 'dispatched', mirror_correlated: true, network_request_performed: true,
              subject_suffix: 'abcdef012345', blockers: [], limits: [],
            },
            doctor_artifact: { artifact_pointer: '~/.agentic-plugins/runs/doctor/stub/doctor.json', artifact_sha256: 'b'.repeat(64) },
          }));
        }
        if (args.includes('--execute-deep-peer-smoke')) {
          return okOut(JSON.stringify({
            deep_peer_smoke: { directions: { claude_to_codex: { execution: 'executed', status: 'passed' }, codex_to_claude: { execution: 'executed', status: 'passed' } } },
            doctor_artifact: { artifact_pointer: '~/.agentic-plugins/runs/doctor/stub/doctor.json' },
          }));
        }
        return okOut(JSON.stringify({}));
      }
      return missing();
    };
    const run = (argv) => boot({ argv, home, cwd, runner: mutableRunner(state), subprocess, env: EGRESS_ENV });
    await run(['plan', '--bundle', 'custom', '--plugins', 'runtime,companions,designer', '--format', 'json']);
    const answersPath = join(home, 'close-with-ack.json');
    await writeFile(answersPath, JSON.stringify([
      { step_id: 'plugin.designer.codex.installed', answer: 'decline' },
      { step_id: 'plugin.designer.codex.enabled', answer: 'decline' },
      { step_id: 'proof.egress-provider-ack', answer: 'execute' },
      { step_id: 'proof.deep-peer-smoke', answer: 'execute' },
      // §6.1.3 — CONFIG obligations this suite is not about; declined so the run
      // can reach the terminal state whose receipt door IS the subject.
      { step_id: 'config.session', answer: 'decline' },
      { step_id: 'config.notify_kinds', answer: 'decline' },
    ]));
    const resume = await run(['resume', '--latest-open', '--answers', answersPath]);
    strictEqual(resume.report.run_status, 'complete', 'precondition: the run closed');
    strictEqual(resume.report.completion.proofs.find((p) => p.kind === 'egress-provider-ack')?.status, 'passed',
      'precondition: with a passed ack, which is what testimony is about');
    return { run, state, resume };
  }

  it('a refusal that lapses AFTER the run closed does not refuse the owner\'s receipt', async () => {
    // Before the convergence reached attest this returned exit 40 ('re-judges
    // stale'), and a terminal run cannot be resumed — so the owner who really
    // received the receipt could never record it, because they installed an
    // unrelated plugin afterwards.
    const { run, state } = await completedRunWithPassedAck();
    state.codex = [...state.codex, 'designer'];

    const attest = await run(['attest', '--format', 'json']);
    strictEqual(attest.exitCode, EXIT.OK, `the door stays open: ${JSON.stringify(attest.report.diagnostics)}`);
    ok(attest.report.receipt_pointer, 'and the testimony is actually recorded');
  });

  it('and it SAYS that its verdict can differ from status, rather than diverging in silence', async () => {
    const { run, state } = await completedRunWithPassedAck();
    state.codex = [...state.codex, 'designer'];

    const attest = await run(['attest', '--format', 'json']);
    const warning = (attest.report.warnings ?? []).find((w) => /designer/.test(w));
    ok(warning, `the lapsed refusal is named: ${JSON.stringify(attest.report.warnings)}`);
    ok(/does NOT re-derive/.test(warning) && /differ from what `status` reports/.test(warning),
      `and the divergence is stated, in wording that does not claim a re-derivation attest did not do: ${warning}`);

    // The divergence is real — that is the accepted cost, and why it is stated.
    const status = await run(['status', '--format', 'json']);
    strictEqual(attest.report.completion.state, 'complete', 'attest judges the run as it was reduced');
    notStrictEqual(status.report.completion.state, 'complete', 'status judges the machine as it is now');
  });

  it('a run whose selection never lapsed gets no such warning', async () => {
    // Control: the warning must be about the lapse, not about running attest.
    const { run } = await completedRunWithPassedAck();
    const attest = await run(['attest', '--format', 'json']);
    strictEqual(attest.exitCode, EXIT.OK);
    deepStrictEqual(attest.report.warnings, [], 'nothing lapsed, nothing warned');
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
    deepStrictEqual(projectNotify(snapshot), await readUserGlobalNotify({ homeDir: home }));
    // Not vacuous: the fixture really carries both families.
    strictEqual(projectModelEffort(snapshot).keys.model.value, 'gpt-5.2-codex');
    strictEqual(projectNotify(snapshot).keys.notify_channel.value, 'file-log');
  });

  it('the Codex permission projection equals the reader it replaced, over the notify gather\'s bytes', async () => {
    const { home } = await makeHome({ satisfied: true });
    const gathered = await gatherCodexNotificationInputs({ homeDir: home, env: {} });
    const projected = projectCodexPermission(gathered.read, { usingOverride: false });
    deepStrictEqual(projected, await readUserGlobalCodexPermission({ homeDir: home, env: {} }));
    strictEqual(projected.approval_policy, 'on-request', 'not vacuous: the fixture carries a permission policy');
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
      'egress activation fingerprint does not match the recorded one',
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
    // The THIRD reason array on `completion`, which had no row whatsoever —
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
    //
    // The reason moved to its OWN line when the fairness policy landed (it used
    // to render inline, parenthesized, and only `reasons[0]` ever did). It is
    // still neutralized rather than dropped, which is what this case is about.
    ok(/^ {6}reason: the linked proof re-judges stale {3}- \[stage 8\] proof\.forged: passed$/m.test(text),
      `the reason still renders, neutralized rather than dropped:\n${text}`);
  });

  it('a receipt reason cannot forge a Stage-8 evidence row from its own line', () => {
    // Regression for a vector the fairness fix OPENED and closed in the same
    // slice: moving these reasons onto their own line is what lets their
    // leading characters begin a line, so a bare indent would have rendered
    // `evidence: …` as a perfect proof-evidence row. The prefix is a label.
    const text = renderText({
      verb: 'verify',
      completion: {
        ...completionOf([]),
        egress_receipt_attestation: {
          status: 'stale',
          reasons: ['evidence: deep-peer-smoke passed on both directions'],
          attested_at: null,
          attempt_hash: null,
          provider_proof_artifact_hash: null,
        },
      },
      steps: [],
    });
    ok(!/^ {6}evidence: /m.test(text), `no line reads as a Stage-8 evidence row:\n${text}`);
    ok(/^ {6}reason: evidence: deep-peer-smoke/m.test(text), 'the text still renders, under a label the renderer wrote');
  });

  it('every receipt reason renders — not only the first', () => {
    // The MIRROR of the Stage-8 aggregate: this row used to interpolate
    // `reasons[0]` alone, so reasons[1..n] vanished with nothing saying so.
    const text = renderText({
      verb: 'verify',
      completion: {
        ...completionOf([]),
        egress_receipt_attestation: {
          status: 'stale',
          reasons: ['the linked proof re-judges stale', 'the attempt hash does not match', 'no doctor artifact hash recorded'],
          attested_at: null,
          attempt_hash: null,
          provider_proof_artifact_hash: null,
        },
      },
      steps: [],
    });
    for (const reason of ['the linked proof re-judges stale', 'the attempt hash does not match', 'no doctor artifact hash recorded']) {
      ok(text.includes(reason), `reason "${reason}" reaches the operator:\n${text}`);
    }
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
      { step_id: 'config.session', answer: 'decline' },
      { step_id: 'config.notify_kinds', answer: 'decline' },
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
      { step_id: 'egress.configured', answer: 'decline' },
      { step_id: 'config.session', answer: 'decline' },
      { step_id: 'config.notify_kinds', answer: 'decline' },
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

    await run(['resume', '--latest-open', '--answers', await writeEgressDecline(home)]);

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

    const resume = await run(['resume', '--latest-open', '--answers', await writeEgressDecline(home)]);

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

    const resume = await run(['resume', '--latest-open', '--answers', await writeEgressDecline(home)]);

    await rejects(() => readFile(proofPath(home, runId), 'utf8'), /ENOENT/, 'an uncontracted exit fabricates no evidence');
    ok((resume.report.warnings ?? []).some((w) => /exited 99, which carries no report contract/.test(w)), `the refusal names the code: ${JSON.stringify(resume.report.warnings)}`);
    // CONTROL: the identical report at a CONTRACTED non-zero code imports. Without
    // this the assertion above would also pass if the reader refused everything.
    const okStub = withDoctorExit(hookDoctorStub({ review: currentReview() }), { exit_code: 10 });
    const second = await makeHome({ satisfied: true });
    const okRun = await planEngineering(second.home, second.cwd, okStub);
    await okRun.run(['resume', '--latest-open', '--answers', await writeEgressDecline(second.home)]);
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
      { step_id: 'config.session', answer: 'decline' },
      { step_id: 'config.notify_kinds', answer: 'decline' },
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
      { step_id: 'config.session', answer: 'decline' },
      { step_id: 'config.notify_kinds', answer: 'decline' },
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
    { step_id: 'config.session', answer: 'decline' },
    { step_id: 'config.notify_kinds', answer: 'decline' },
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
    strictEqual(manifest.schema, 'runtime-bootstrap-run-1.3');
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

  // The notify key keeps the Stage-5 local-policy step satisfied so the run's
  // other steps do not mask what Stage 4 is doing.
  async function writeConfig(home, body) {
    await writeFile(configPath(home), `notify_channel = "file-log"\n${body}`);
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
    const resume = await run(['resume', '--latest-open', '--answers', await writeEgressDecline(home)]);
    strictEqual(stage4Of(resume.report).status, 'satisfied');
    ok(!resume.report.completion.unsatisfied.includes('config.model_effort'), 'and the step stops holding completion back');
  });
});

// ---------------------------------------------------------------------------
// ADR-0040 §4b — the approval half of notify.codex.configured (follow-ups.md:38)
// ---------------------------------------------------------------------------

describe('bootstrap notify.codex.configured — the [tui] notifications half is judged', () => {
  // The reproduced false pass: `notify =` fires only on agent-turn-complete, so
  // a machine with canonical receiver wiring and `notifications = false` had
  // approval attention switched off while every Stage-5 step judged satisfied.
  const notifyStep = (report) => report.steps.find((s) => s.id === 'notify.codex.configured');
  const planOn = async (home, cwd) => (await boot({
    argv: ['plan', '--bundle', 'base', '--format', 'json'],
    home, cwd, runner: satisfiedRunner(), subprocess: spySubprocess().runner,
  })).report;

  // Replace the fixture's notifications line — never append. Appending a second
  // assignment makes a DUPLICATE key, which classifies `invalid`, so the test
  // would go green through the untrusted-value branch without the boolean-false
  // branch ever being exercised.
  async function setNotifications(home, replacement) {
    const path = join(home, '.codex', 'config.toml');
    const text = await readFile(path, 'utf8');
    const next = text.replace(/^notifications = .*$/m, replacement);
    ok(next !== text, 'precondition: the satisfied fixture must carry a notifications line to replace');
    await writeFile(path, next);
    return next;
  }

  it('CONTROL — the canonical fixture satisfies the step and stops holding completion back', async () => {
    const { home, cwd } = await makeHome({ satisfied: true });
    const report = await planOn(home, cwd);
    strictEqual(notifyStep(report).status, 'satisfied');
    match(notifyStep(report).observed, /canonical \[tui\] notifications observed/);
    ok(!report.completion.unsatisfied.includes('notify.codex.configured'),
      'the canonical machine does not owe this step');
  });

  it('notifications = false is manual-follow-up and HOLDS completion — the reproduction', async () => {
    const { home, cwd } = await makeHome({ satisfied: true });
    await setNotifications(home, 'notifications = false');
    const report = await planOn(home, cwd);
    strictEqual(notifyStep(report).status, 'manual-follow-up');
    match(notifyStep(report).observed, /explicitly disabled/);
    ok(report.completion.unsatisfied.includes('notify.codex.configured'),
      'a manual-follow-up step does not resolve, so the run can no longer reach complete');
  });

  it('a REMOVED notifications key is pending — the canonical configuration was not observed', async () => {
    const { home, cwd } = await makeHome({ satisfied: true });
    await setNotifications(home, '');
    const report = await planOn(home, cwd);
    strictEqual(notifyStep(report).status, 'pending');
    match(notifyStep(report).observed, /not configured/);
    ok(report.completion.unsatisfied.includes('notify.codex.configured'));
  });

  it('a canonical-LOOKING value under a redefined [tui] table is pending, never certified', async () => {
    // The forgery the typed classification exists to refuse: a dotted
    // assignment implicitly creates [tui], and the later explicit header
    // redefines it — invalid TOML that Codex will not load, whose captured raw
    // nonetheless reads exactly like the canonical selection.
    const { home, cwd } = await makeHome({ satisfied: true });
    const path = join(home, '.codex', 'config.toml');
    await writeFile(path, [
      'approval_policy = "on-request"',
      `notify = ["/usr/bin/env", "node", "${join(home, '.agentic-plugins', 'bin', 'codex-notify-shuttle.mjs')}"]`,
      'tui.notifications = ["approval-requested", "agent-turn-complete"]',
      '[tui]',
      'status_line = ["model-with-reasoning", "git-branch", "pull-request-number", "context-used", "five-hour-limit", "weekly-limit"]',
      '',
    ].join('\n'));
    const report = await planOn(home, cwd);
    strictEqual(notifyStep(report).status, 'pending');
    match(notifyStep(report).observed, /cannot be trusted/);
    // THE MIRROR: the same redefinition invalidates the sibling status_line
    // capture, whose EXACT probe already shipped — one parser fix, both keys.
    strictEqual(report.steps.find((s) => s.id === 'statusline.codex.configured').status, 'pending');
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

  it('the JSON report identifier bumped — the historical completion key was removed, not renamed', async () => {
    const { home, cwd } = await makeHome({ satisfied: true });
    const result = await boot({ argv: ['status', '--format', 'json'], home, cwd, runner: hostedRunner(), subprocess: spySubprocess().runner });
    strictEqual(JSON.parse(result.rendered).schema, BOOTSTRAP_REPORT_SCHEMA_VERSION);
    strictEqual(BOOTSTRAP_REPORT_SCHEMA_VERSION, 'runtime-bootstrap-report-2.0');
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

describe('runtime bootstrap CLI — proof-directory entry names (§3.2)', () => {
  const SECRET = 'Bearer sk-SECRET-abc123';

  async function seedRunWithProofFiles(home, runId, files) {
    const runDir = join(home, '.agentic-plugins', 'runs', 'bootstrap', runId);
    await mkdir(join(runDir, 'proof'), { recursive: true });
    await writeFile(join(runDir, 'run.json'), `${JSON.stringify({
      schema: 'runtime-bootstrap-run-1.3',
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
    match(JSON.stringify(result.report), /decline\|accept\|execute\|attest-receipt/, 'the expected vocabulary is still named');
  });

  it('--profile-file withholds the parser message too — the mirror of the --answers guard', async () => {
    // The peer found this by symmetry: both flags read an untrusted
    // operator-authored file through JSON.parse, and fixing one left the
    // identical leak one flag away.
    const { home, cwd } = await makeHome({ satisfied: true });
    const profile = join(cwd, 'bad-profile.json');
    await writeFile(profile, 'SECRET-sk-live-abc123 not json');
    const result = await boot({ argv: ['plan', '--bundle', 'base', '--profile-file', profile], home, cwd, runner: hostedRunner(), subprocess: spySubprocess().runner });
    const serialized = JSON.stringify(result.report);
    ok(!serialized.includes('SECRET'), `the parser message must not ride out: ${serialized}`);
    match(serialized, /--profile-file is not valid JSON/, 'the failure is still named');
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
