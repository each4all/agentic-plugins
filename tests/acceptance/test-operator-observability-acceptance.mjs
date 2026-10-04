// ADR-0040 - operator situational awareness: BLACK-BOX ACCEPTANCE.
//
// This suite was the holistic acceptance gate for the ADR-0040 series. It proved
// five properties end-to-end through the real entry points: (a) the notify.mjs
// emit pipeline, (b) the emitter's fail-closed behaviour, (c) the
// `runtime:dashboard` aggregate, (d) `runtime:settings --notification-plan` as
// M1 no-host-write, and (e) the subprocess-only boundary around the emit
// substrate. ADR-0064 Decision 1 removed notification and egress, and with them
// (a), (b), (d) and (e); its attention sensor cases had already gone with
// attention's notification sensors. What remains is (c):
//
//   `runtime:dashboard` aggregate over fixture state -- all three personas incl.
//   the founder namespace, Tier 2 freshness, and the absence of the notify row
//   even when leftover notify config and state are on disk (Decision 9: leftover
//   configuration is inert).
//
// The per-component suite (tests/runtime/test-dashboard.mjs) proves the
// mechanics in depth; THIS suite drives the REAL `dashboard.mjs` CLI as a black
// box over state seeded by the personas' real `state.mjs create` CLIs.
//
// Host-free + deterministic: a throwaway git repo + a fixture HOME so no real
// user config leaks in. Run via
// `node --test tests/acceptance/test-operator-observability-acceptance.mjs`.

import { describe, it, before, after } from 'node:test';
import { strictEqual, ok, deepStrictEqual } from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runGit, runNode, runNodeOk } from './_helpers.mjs';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../../..');
const RUNTIME_ROOT = resolve(REPO_ROOT, 'plugins/runtime');
const DASHBOARD_CLI = resolve(RUNTIME_ROOT, 'scripts/dashboard.mjs');

// Where the removed emitter kept its state (ADR-0040 sec.1). Hardcoded: nothing
// in the runtime names this path any more, and a black-box observer seeds the
// documented location rather than importing a layout helper.
const NOTIFY_DIR_REL = join('.agentic-plugins', 'state', 'runtime', 'notify');

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function tmp(prefix) {
  return mkdtempSync(join(tmpdir(), `adr0040-${prefix}-`));
}

// A real git repo for the dashboard fixture -- the persona `state.mjs create`
// CLIs stamp a git baseline, so they want a repo with at least one commit.
function realGitRepo(prefix, branch = 'feat/x') {
  const root = tmp(prefix);
  runGit(['init', '-q', '-b', branch], { cwd: root });
  runGit(['config', 'user.name', 'adr0040-accept'], { cwd: root });
  runGit(['config', 'user.email', 'adr0040-accept@example.invalid'], { cwd: root });
  runGit(['config', 'commit.gpgsign', 'false'], { cwd: root });
  runGit(['commit', '-q', '--allow-empty', '-m', 'baseline', '--no-verify'], { cwd: root });
  return { root, branch };
}

// An empty fixture HOME so the user config layer
// (<HOME>/.agentic-plugins/config.toml) is always absent -- the real developer's
// ~/.agentic-plugins config must never leak into an acceptance assertion.
function fixtureHome() {
  return tmp('home');
}

// ===========================================================================
// runtime:dashboard aggregate -- 3 personas incl. founder, Tier 2, no notify row
// ===========================================================================

describe('ADR-0040 acceptance (c) -- dashboard aggregate over fixture state', () => {
  let root;
  let home;
  before(async () => {
    const repo = realGitRepo('dash');
    root = repo.root;
    home = fixtureHome();
    const branch = repo.branch;
    const head = runGit(['rev-parse', 'HEAD'], { cwd: root });

    // Seed one workflow in EACH persona namespace via the real create CLIs, so
    // Tier 1 aggregates genuine fixture state (founder proves the direct
    // namespace scan the ADR sec.6 added on top of doctor's engineer+orchestrator).
    const create = (persona, extra) => runNodeOk([
      resolve(REPO_ROOT, `plugins/${persona}/scripts/state.mjs`), 'create',
      '--repo-root', root, '--host', 'claude',
      '--git-baseline-branch', branch, '--git-baseline-head', head,
      '--status-digest', 'deadbeef', ...extra,
    ]);
    create('engineer', ['--verb', 'compose', '--persona', 'engineer', '--profile', 'backend', '--original-request', 'acc', '--current-phase', 'phase-0', '--next-action', 'go']);
    create('orchestrator', ['--verb', 'plan', '--original-request', 'acc macro']);
    create('founder', ['--verb', 'compose', '--persona', 'founder', '--original-request', 'acc venture']);

    // Leftover notify config + a file-log record, as a machine that used the
    // removed emitter still holds them. Before ADR-0064 these surfaced as the
    // Tier 2 notify row; now nothing reads them.
    await mkdir(join(root, '.agentic-plugins'), { recursive: true });
    await writeFile(join(root, '.agentic-plugins', 'config.toml'), 'notify_channel = "file-log"\n');
    await mkdir(join(root, NOTIFY_DIR_REL), { recursive: true });
    await writeFile(join(root, NOTIFY_DIR_REL, 'log.ndjson'), `${JSON.stringify({ ts: '2026-07-04T00:00:00.000Z', event_id: 'accept:approval:session:s:h:fired', kind: 'approval', title: 't', body: 'b' })}\n`);
  });
  after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  function dashboard(format) {
    const res = runNode([DASHBOARD_CLI, '--repo-root', root, '--format', format], { env: { HOME: home } });
    strictEqual(res.status, 0, res.stderr);
    return res.stdout;
  }

  it('reports all three persona namespaces, with the founder workflow surfaced', () => {
    const report = JSON.parse(dashboard('json'));
    deepStrictEqual(Object.keys(report.tier1.personas).sort(), ['engineer', 'founder', 'orchestrator']);
    // Founder is scanned as a first-class namespace (not merely a static key).
    ok(report.tier1.personas.founder.workflows.count >= 1, 'the seeded founder workflow is aggregated');
    ok(report.tier1.personas.engineer.workflows.count >= 1, 'the seeded engineer workflow is aggregated');
  });

  it('surfaces Tier 2 freshness with CONCRETE reader output, and no notify row', () => {
    const report = JSON.parse(dashboard('json'));
    // Codex-caught: key presence is hollow (buildReport always emits these
    // keys). Assert the freshness readers actually RAN and CLASSIFIED the
    // fixture: no doctor or settings artifacts were seeded, so each must
    // report the concrete 'missing' status -- an inert `{}` would have an
    // undefined status and fail.
    strictEqual(report.tier2.doctor.status, 'missing', 'the doctor-freshness reader ran and classified absence');
    strictEqual(report.tier2.settings.status, 'missing', 'the settings-recency reader ran and classified absence');
    // ADR-0060 removed host-version tracking, and dashboard 3.0 dropped the
    // compat and baseline rows with it; ADR-0064 removed notification and
    // egress, and dashboard 4.0 dropped the notify row. Their absence is the
    // contract: a row that came back would report on something nothing
    // performs any more.
    strictEqual(report.schema_version, 'runtime-dashboard-4.0');
    ok(!('compat' in report.tier2), 'the compat row is gone');
    ok(!('baseline' in report.tier2), 'the baseline row is gone');
    ok(!('notify' in report.tier2), 'the notify row is gone, though leftover notify config and state are on disk');
  });

  it('the text rendering carries no notify row or leftover notification either', () => {
    const text = dashboard('text');
    ok(text.includes('## Tier 2 — operator health'), 'control: the Tier 2 section rendered');
    const tier2 = text.slice(text.indexOf('## Tier 2'));
    ok(!/notif|egress/i.test(tier2), `no notify or egress line may render:\n${tier2}`);
    ok(!text.includes('accept:approval:session:s:h:fired'), 'the leftover file-log record is not surfaced');
  });
});
