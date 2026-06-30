// ADR-0038 acceptance verification (the `acceptance-verify` slice, 9/9).
//
// End-to-end proof that the shipped A+C permission advisor surface works on the
// committed Claude + Codex usage-record fixtures AND honors its boundary:
//   - runtime:doctor --permission-diagnosis (R0) classifies prompt causes by
//     host x mechanism, writes NO artifact, and leaks no secret;
//   - runtime:settings --permission-plan (M1) emits the cross-host plan as ONE
//     combined advisory artifact and writes NO host config;
//   - even with --apply, settings writes ONLY agentic-plugins-owned config —
//     the host .claude/settings.json and $CODEX_HOME/config.toml are untouched.
//
// Black-box: drives the public runDoctor/runSettings entry points on the real
// fixtures, and reads assertions from the fixtures' manifest oracle.
import { describe, it } from 'node:test';
import { strictEqual, ok, rejects, deepStrictEqual } from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, copyFile, stat, readdir } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runDoctor, formatText as formatDoctor } from '../../plugins/runtime/scripts/doctor.mjs';
import { runSettings, formatText as formatSettings } from '../../plugins/runtime/scripts/settings.mjs';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'usage-records');
const MANIFEST = JSON.parse(readFileSync(join(FIXTURES, 'manifest.json'), 'utf8'));
// The synthetic secret canaries the redaction fixture must never leak (oracle).
const SECRET_CANARIES = (MANIFEST.fixtures.find((f) => f.file === 'claude-secret-redaction.jsonl') || {}).must_not_contain || [];
const NOW = new Date('2026-06-30T09:00:00.000Z');

// Every prompt cause the committed fixtures exercise across both hosts.
const EXPECTED_CAUSES = [
  'claude.bash-not-allowlisted',
  'claude.file-modification',
  'claude.webfetch-domain',
  'claude.mcp-not-allowed',
  'codex.sandbox-blocked',
  'codex.approval-requested',
];

function okResult(stdout = '') {
  return { ok: true, exit_code: 0, stdout, stderr: '', error_code: null, timed_out: false };
}

// Lean CLI map covering the version/help/auth probes; unmapped probes degrade to
// ENOENT (reported unknown, never a crash). The permission sections under test
// do not depend on these probe results.
function cliMap() {
  return {
    'claude --version': okResult('2.1.140 (Claude Code)\n'),
    'claude --help': okResult('Usage: claude --print --output-format --model --effort --permission-mode --plugin-dir\nCommands:\n  auth status\n  plugin list\n'),
    'claude auth status': okResult(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty' })),
    'claude plugin list': okResult('Installed plugins:\n'),
    'codex --version': okResult('codex-cli 0.142.3\n'),
    'codex --help': okResult('Commands:\n  exec\n  login status\nOptions:\n  --model\n  --sandbox\n  --ask-for-approval\n'),
    'codex login status': okResult('Logged in using ChatGPT\n'),
  };
}

function fakeRunner(map) {
  return async (command, args) => {
    const key = `${command} ${args.join(' ')}`;
    return map[key] ?? { ok: false, exit_code: null, stdout: '', stderr: '', error_code: 'ENOENT', timed_out: false };
  };
}

// Seed Claude transcripts under home/.claude and Codex rollouts under a SEPARATE
// codexHome dir (passed as $CODEX_HOME) so the test independently proves the
// CODEX_HOME override is honored (not merely the home/.codex fallback).
async function seedAdvisorHome() {
  const home = await mkdtemp(join(tmpdir(), 'runtime-acceptance-home-'));
  const codexHome = await mkdtemp(join(tmpdir(), 'runtime-acceptance-codex-'));
  await mkdir(join(home, '.claude', 'projects', 'acme'), { recursive: true });
  await copyFile(join(FIXTURES, 'claude-session-readable.jsonl'), join(home, '.claude', 'projects', 'acme', 'session.jsonl'));
  await copyFile(join(FIXTURES, 'claude-secret-redaction.jsonl'), join(home, '.claude', 'projects', 'acme', 'secret.jsonl'));
  await mkdir(join(codexHome, 'sessions', '2026', '06', '30'), { recursive: true });
  await copyFile(join(FIXTURES, 'codex-session-readable.jsonl'), join(codexHome, 'sessions', '2026', '06', '30', 'rollout-acme.jsonl'));
  return { home, codexHome };
}

const envFor = (codexHome) => ({ ...process.env, CODEX_HOME: codexHome });

function assertNoSecrets(haystack, label) {
  ok(SECRET_CANARIES.length > 0, 'manifest provides secret canaries');
  for (const canary of SECRET_CANARIES) {
    ok(!haystack.includes(canary), `${label} must not leak ${canary}`);
  }
}

describe('ADR-0038 acceptance: permission advisor end-to-end on fixtures', () => {
  it('doctor --permission-diagnosis (R0) classifies the full host x mechanism cause set, writes no artifact, leaks no secret', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-acceptance-repo-'));
    const { home, codexHome } = await seedAdvisorHome();
    const report = await runDoctor({
      repoRoot: root,
      homeDir: home,
      env: envFor(codexHome),
      permissionDiagnosis: true,
      now: NOW,
      runner: fakeRunner(cliMap()),
    });
    const pd = report.permission_diagnosis;
    strictEqual(pd.status, 'analyzed');
    deepStrictEqual([...pd.hosts].sort(), ['claude', 'codex']);
    // Full host x mechanism coverage: every fixture cause appears, across the
    // pattern-rule rollup (by_cause) and the mode postures (file-mod/approval).
    const causes = new Set([...pd.by_cause.map((c) => c.cause), ...pd.mode_postures.map((m) => m.cause)]);
    for (const cause of EXPECTED_CAUSES) ok(causes.has(cause), `cause ${cause} classified`);
    const mechanisms = new Set(pd.by_cause.map((c) => c.mechanism));
    for (const mech of ['bash', 'webfetch', 'mcp', 'sandbox', 'approval']) ok(mechanisms.has(mech), `mechanism ${mech} present`);
    // R0: doctor writes no permission-family artifact.
    await rejects(() => stat(join(root, '.agentic-plugins', 'runs', 'permission')), /ENOENT/);
    // Privacy: every synthetic secret canary is redacted in report + text.
    assertNoSecrets(JSON.stringify(report), 'doctor report');
    assertNoSecrets(formatDoctor(report), 'doctor text');
    ok(formatDoctor(report).includes('Permission Diagnosis'));
  });

  it('settings --permission-plan (M1) emits the cross-host plan as ONE combined on-disk artifact, no host write, no secret leak', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-acceptance-repo-'));
    const { home, codexHome } = await seedAdvisorHome();
    // Existing host config that must stay byte-identical (both Claude paths + Codex).
    await mkdir(join(root, '.claude'), { recursive: true });
    const claudeSettings = `${JSON.stringify({ permissions: { allow: ['Bash(ls *)'] } }, null, 2)}\n`;
    const claudeLocal = `${JSON.stringify({ permissions: { allow: ['Bash(pwd)'] } }, null, 2)}\n`;
    await writeFile(join(root, '.claude', 'settings.json'), claudeSettings);
    await writeFile(join(root, '.claude', 'settings.local.json'), claudeLocal);
    const codexCfg = 'approval_policy = "untrusted"\nsandbox_mode = "read-only"\n';
    await writeFile(join(codexHome, 'config.toml'), codexCfg);

    const report = await runSettings({
      repoRoot: root,
      homeDir: home,
      env: envFor(codexHome),
      permissionPlan: true,
      now: NOW,
      runner: fakeRunner(cliMap()),
    });

    const pp = report.permission_plan;
    const cp = report.permission_plan_codex;
    strictEqual(pp.status, 'analyzed');
    strictEqual(cp.status, 'analyzed');
    // ONE combined cross-host artifact, shared by both sections.
    strictEqual(pp.artifact.run_id, cp.artifact.run_id);
    const advisory = JSON.parse(await readFile(join(root, '.agentic-plugins', 'runs', 'permission', pp.artifact.run_id, 'advisory.json'), 'utf8'));
    strictEqual(advisory.surface, 'settings');
    deepStrictEqual(advisory.hosts, ['claude', 'codex']);
    ok(advisory.plan.some((f) => f.host === 'claude'), 'claude fragment in the combined artifact');
    ok(advisory.plan.some((f) => f.host === 'codex'), 'codex fragment in the combined artifact');
    const latest = JSON.parse(await readFile(join(root, '.agentic-plugins', 'runs', 'permission', 'latest.json'), 'utf8'));
    strictEqual(latest.run_id, pp.artifact.run_id, 'latest.json points at the shared run (no clobber)');
    const runDirs = (await readdir(join(root, '.agentic-plugins', 'runs', 'permission'), { withFileTypes: true })).filter((e) => e.isDirectory());
    strictEqual(runDirs.length, 1, 'exactly one combined run directory');

    // Host config untouched (both Claude paths + Codex), dry-run.
    strictEqual(await readFile(join(root, '.claude', 'settings.json'), 'utf8'), claudeSettings);
    strictEqual(await readFile(join(root, '.claude', 'settings.local.json'), 'utf8'), claudeLocal);
    strictEqual(await readFile(join(codexHome, 'config.toml'), 'utf8'), codexCfg);
    strictEqual(report.dry_run, true);

    // Privacy across report + text + the written artifact.
    assertNoSecrets(JSON.stringify(report), 'settings report');
    assertNoSecrets(formatSettings(report), 'settings text');
    assertNoSecrets(JSON.stringify(advisory), 'advisory artifact');
    const text = formatSettings(report);
    ok(text.includes('Permission Plan (Claude, dry-run)'));
    ok(text.includes('Permission Plan (Codex, dry-run)'));
  });

  it('proves NO host-config writes even with --apply (only agentic-plugins config is written)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-acceptance-repo-'));
    const { home, codexHome } = await seedAdvisorHome();
    await mkdir(join(root, '.agentic-plugins'), { recursive: true });
    await writeFile(join(root, '.agentic-plugins', 'config.toml'), 'codex_model = "old"\n');
    await mkdir(join(root, '.claude'), { recursive: true });
    const claudeCfg = `${JSON.stringify({ permissions: { allow: ['Bash(ls *)'] } }, null, 2)}\n`;
    await writeFile(join(root, '.claude', 'settings.json'), claudeCfg);
    const codexCfg = 'approval_policy = "untrusted"\nsandbox_mode = "read-only"\n';
    await writeFile(join(codexHome, 'config.toml'), codexCfg);

    const report = await runSettings({
      repoRoot: root,
      homeDir: home,
      env: envFor(codexHome),
      permissionPlan: true,
      apply: true,
      target: 'repo',
      desired: { codex_model: 'new' },
      runner: fakeRunner(cliMap()),
    });

    strictEqual(report.dry_run, false); // --apply exercises the real write path
    // The ONLY write target is agentic-plugins-owned config.
    ok((await readFile(join(root, '.agentic-plugins', 'config.toml'), 'utf8')).includes('codex_model = "new"'));
    // Host config byte-identical — proven under a real --apply + --permission-plan.
    strictEqual(await readFile(join(root, '.claude', 'settings.json'), 'utf8'), claudeCfg);
    strictEqual(await readFile(join(codexHome, 'config.toml'), 'utf8'), codexCfg);
    ok(report.mutation_boundary.forbidden.includes('host-native Claude Code config'));
    ok(report.mutation_boundary.forbidden.includes('host-native Codex CLI config'));
    strictEqual(report.permission_plan.artifact.written, true);
  });

  it('degrades to a conservative baseline (R0 no_records / M1 baseline) when no usage records exist', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-acceptance-repo-'));
    const home = await mkdtemp(join(tmpdir(), 'runtime-acceptance-home-'));
    const codexHome = await mkdtemp(join(tmpdir(), 'runtime-acceptance-codex-'));
    const doctorReport = await runDoctor({
      repoRoot: root, homeDir: home, env: envFor(codexHome), permissionDiagnosis: true, now: NOW, runner: fakeRunner(cliMap()),
    });
    strictEqual(doctorReport.permission_diagnosis.status, 'no_records');
    await rejects(() => stat(join(root, '.agentic-plugins', 'runs', 'permission')), /ENOENT/);

    const settingsReport = await runSettings({
      repoRoot: root, homeDir: home, env: envFor(codexHome), permissionPlan: true, now: NOW, runner: fakeRunner(cliMap()),
    });
    strictEqual(settingsReport.permission_plan.status, 'baseline');
    strictEqual(settingsReport.permission_plan_codex.status, 'baseline');
    strictEqual(settingsReport.permission_plan.recommended.count, 0);
    strictEqual(settingsReport.permission_plan_codex.recommended.count, 0);
  });
});
