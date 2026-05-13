import { describe, it } from 'node:test';
import { strictEqual, ok, rejects, deepStrictEqual } from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { formatText, parseArgs, runDoctor, RUNTIME_VERSION } from '../../plugins/runtime/scripts/doctor.mjs';

describe('runtime doctor', () => {
  it('builds a sanitized read-only report from source, CLI, companion, config, and ledger probes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-doctor-repo-'));
    const home = await mkdtemp(join(tmpdir(), 'runtime-doctor-home-'));
    await seedRepo(root);
    await seedHome(home);
    const report = await runDoctor({
      repoRoot: root,
      homeDir: home,
      now: new Date('2026-05-13T00:00:00.000Z'),
      explicitModel: 'gpt-5.4',
      explicitEffort: 'high',
      runner: fakeRunner({
        'claude --version': okResult('2.1.140 (Claude Code)\n'),
        'claude --help': okResult('Usage: claude --print --output-format --no-session-persistence --model --effort --permission-mode --plugin-dir\nCommands:\n  auth status\n  plugin list\n'),
        'claude auth status': okResult(JSON.stringify({
          loggedIn: true,
          authMethod: 'claude.ai',
          apiProvider: 'firstParty',
          email: 'person@example.com',
          orgId: '11111111-2222-3333-4444-555555555555',
          orgName: 'private org',
          subscriptionType: 'max',
        })),
        'claude plugin list': okResult('Installed plugins:\n\n  > runtime@agentic-plugins\n    Version: 0.1.0\n    Scope: user\n    Status: enabled\n'),
        'codex --version': okResult('codex-cli 0.130.0\n'),
        'codex --help': okResult('Commands:\n  exec Run Codex non-interactively\n  login status\n  plugin marketplace\nOptions:\n  --model\n  --config\n  --cd\n  --sandbox\n  --ask-for-approval\n'),
        'codex exec --help': okResult('Usage: codex exec --cd <DIR> --model <MODEL> --config model_reasoning_effort=\"high\"\n'),
        'codex features list': okResult('hooks stable true\nplugin_hooks under development false\nplugins stable true\nmulti_agent stable true\n'),
        'codex login status': okResult('Logged in using sk-proj-abcdefghijklmnopqrstuvwxyz1234567890\n'),
        'codex plugin marketplace --help': okResult('Commands:\n  add\n  upgrade\n  remove\n'),
      }),
    });

    strictEqual(report.read_only, true);
    strictEqual(report.runtime_version, RUNTIME_VERSION);
    strictEqual(report.clis.claude.auth.status, 'available');
    strictEqual(report.clis.claude.auth.method, 'claude.ai');
    strictEqual(report.clis.claude.auth.provider, 'firstParty');
    strictEqual(report.clis.claude.auth.subscription, 'max');
    strictEqual(report.model_effort.directions.claude_to_codex.model.source, 'explicit command flags');
    strictEqual(report.model_effort.directions.codex_to_claude.effort.value, 'high');
    strictEqual(report.companions.directions.claude_to_codex.status, 'available');
    strictEqual(report.companions.directions.codex_to_claude.status, 'available');
    strictEqual(report.ledgers.engineer.peer_runs.stale_non_terminal, 1);
    strictEqual(report.ledgers.engineer.storage.status, 'migration_blocked');
    strictEqual(report.ledgers.engineer.storage.selected_home, 'legacy');
    strictEqual(report.ledgers.engineer.storage.legacy_has_state, true);
    strictEqual(report.ledgers.engineer.storage.canonical_has_state, false);
    strictEqual(report.ledgers.orchestrator.storage.status, 'empty');
    strictEqual(report.plugins.runtime.status, 'available');
    strictEqual(report.clis.codex.feature_surface.codex_global_hooks, true);
    strictEqual(report.clis.codex.feature_surface.codex_global_hooks_stage, 'stable');
    strictEqual(report.clis.codex.feature_surface.codex_plugin_hooks, false);
    strictEqual(report.clis.codex.feature_surface.codex_plugin_hooks_stage, 'under development');
    strictEqual(report.clis.codex.feature_surface.automatic_plugin_hooks, false);
    ok(report.host_parity.differences.some((issue) => issue.id === 'codex_manual_skill_invocation'));
    ok(report.host_parity.differences.some((issue) => issue.id === 'codex_manual_skill_invocation' && issue.evidence.includes('global_hooks=true/stable')));

    const serialized = JSON.stringify(report);
    ok(!serialized.includes('person@example.com'), 'email must be redacted');
    ok(!serialized.includes('11111111-2222-3333-4444-555555555555'), 'org id must be redacted');
    ok(!serialized.includes('sk-proj-abcdefghijklmnopqrstuvwxyz1234567890'), 'hyphenated provider token must be redacted');
    ok(formatText(report).includes(`runtime:doctor ${RUNTIME_VERSION}`));
    ok(formatText(report).includes('Host Parity'));
  });

  it('reports stale retired Claude plugin entries as host parity issues', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-doctor-retired-plugin-'));
    const home = await mkdtemp(join(tmpdir(), 'runtime-doctor-home-'));
    await seedRepo(root);
    const report = await runDoctor({
      repoRoot: root,
      homeDir: home,
      runner: fakeRunner({
        ...defaultRuntimeProbeMap(),
        'claude plugin list': okResult([
          'Installed plugins:',
          '',
          '  > research@agentic-plugins',
          '    Version: 0.1.0',
          '    Scope: user',
          '    Status: failed',
          '    Error: retired plugin failed to load',
          '',
        ].join('\n')),
      }),
    });

    ok(report.host_parity.issues.some((issue) => issue.id === 'claude_retired_or_unknown_plugin' && issue.plugin === 'research'));
    strictEqual(report.host_parity.status, 'warning');
    ok(formatText(report).includes('claude_retired_or_unknown_plugin'));
  });

  it('distinguishes missing CLIs as unavailable and fails overall', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-doctor-missing-'));
    const home = await mkdtemp(join(tmpdir(), 'runtime-doctor-home-'));
    await seedRepo(root);
    const report = await runDoctor({
      repoRoot: root,
      homeDir: home,
      runner: fakeRunner({}),
    });
    strictEqual(report.clis.claude.status, 'unavailable');
    strictEqual(report.clis.codex.status, 'unavailable');
    strictEqual(report.overall.status, 'fail');
  });

  it('recognizes installed cache state even when a consumer repo has no plugin source tree', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-doctor-consumer-'));
    const home = await mkdtemp(join(tmpdir(), 'runtime-doctor-home-'));
    await seedHome(home);
    const report = await runDoctor({
      repoRoot: root,
      homeDir: home,
      runner: fakeRunner({}),
    });
    strictEqual(report.plugins.runtime.source.present, false);
    strictEqual(report.plugins.runtime.cache.codex.status, 'available');
    strictEqual(report.plugins.runtime.status, 'available');
  });

  it('does not treat Codex temporary marketplace cache as plugin installation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-doctor-marketplace-only-'));
    const home = await mkdtemp(join(tmpdir(), 'runtime-doctor-home-'));
    await seedCodexTmpMarketplace(home);
    const report = await runDoctor({
      repoRoot: root,
      homeDir: home,
      runner: fakeRunner({}),
    });
    strictEqual(report.plugins.runtime.source.present, false);
    strictEqual(report.plugins.runtime.cache.codex.status, 'missing');
    strictEqual(report.plugins.runtime.cache.codex_tmp_marketplace.status, 'available');
    strictEqual(report.plugins.runtime.status, 'not_installed');
  });

  it('flags malformed non-terminal peer-run handles as blocked ledger health', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-doctor-bad-ledger-'));
    const home = await mkdtemp(join(tmpdir(), 'runtime-doctor-home-'));
    await mkdir(join(root, '.claude', 'agentic-engineer', 'peer-runs', 'bad-run'), { recursive: true });
    await writeJson(join(root, '.claude', 'agentic-engineer', 'peer-runs', 'bad-run', 'handle.json'), {
      run_id: 'bad-run',
      plugin: 'engineer',
      status: 'running',
    });
    const report = await runDoctor({
      repoRoot: root,
      homeDir: home,
      runner: fakeRunner({}),
    });
    strictEqual(report.ledgers.engineer.peer_runs.status, 'blocked');
    strictEqual(report.ledgers.engineer.peer_runs.malformed, 1);
    ok(report.ledgers.engineer.peer_runs.runs[0].issues.includes('non-terminal run missing valid updated_at'));
  });

  it('reports canonical workflow storage when state already lives under .agentic-plugins/state', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-doctor-canonical-ledger-'));
    const home = await mkdtemp(join(tmpdir(), 'runtime-doctor-home-'));
    await mkdir(join(root, '.agentic-plugins', 'state', 'engineer', 'workflows'), { recursive: true });
    await writeWorkflow(join(root, '.agentic-plugins', 'state', 'engineer', 'workflows', 'compose-20260513T000000Z-abcdef.md'), 'feat/canonical');

    const report = await runDoctor({
      repoRoot: root,
      homeDir: home,
      runner: fakeRunner({}),
    });

    strictEqual(report.ledgers.engineer.storage.status, 'canonical');
    strictEqual(report.ledgers.engineer.storage.selected_home, 'canonical');
    strictEqual(report.ledgers.engineer.workflows.count, 1);
    strictEqual(report.ledgers.engineer.homes.legacy.workflows.count, 0);
    ok(formatText(report).includes('storage=canonical'));
  });

  it('reports ambiguous storage when canonical and legacy homes share a workflow branch', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-doctor-ambiguous-ledger-'));
    const home = await mkdtemp(join(tmpdir(), 'runtime-doctor-home-'));
    await mkdir(join(root, '.agentic-plugins', 'state', 'engineer', 'workflows'), { recursive: true });
    await mkdir(join(root, '.claude', 'agentic-engineer', 'workflows'), { recursive: true });
    await writeWorkflow(join(root, '.agentic-plugins', 'state', 'engineer', 'workflows', 'compose-20260513T000000Z-aaaaaa.md'), 'feat/shared');
    await writeWorkflow(join(root, '.claude', 'agentic-engineer', 'workflows', 'compose-20260513T000001Z-bbbbbb.md'), 'feat/shared');

    const report = await runDoctor({
      repoRoot: root,
      homeDir: home,
      runner: fakeRunner({}),
    });

    strictEqual(report.ledgers.engineer.storage.status, 'ambiguous');
    strictEqual(report.ledgers.engineer.storage.selected_home, 'canonical');
    deepStrictEqual(report.ledgers.engineer.storage.overlapping_branches, ['feat/shared']);
  });

  it('reports sandbox and permission readiness as unknown without an explicit peer smoke', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-doctor-readiness-'));
    const home = await mkdtemp(join(tmpdir(), 'runtime-doctor-home-'));
    await seedRepo(root);
    const report = await runDoctor({
      repoRoot: root,
      homeDir: home,
      runner: fakeRunner({
        'claude --version': okResult('2.1.140 (Claude Code)\n'),
        'claude --help': okResult('Usage: claude --print --no-session-persistence --model --effort --permission-mode --plugin-dir\nCommands:\n  auth status\n  plugin list\n'),
        'claude auth status': okResult(JSON.stringify({ loggedIn: true })),
        'claude plugin list': okResult(''),
        'codex --version': okResult('codex-cli 0.130.0\n'),
        'codex --help': okResult('Commands:\n  exec Run Codex non-interactively\n  login status\n  plugin marketplace\nOptions:\n  --model\n  --config\n  --cd\n  --sandbox\n  --ask-for-approval\n'),
        'codex exec --help': okResult('Usage: codex exec --cd <DIR> --model <MODEL> --config model_reasoning_effort=\"high\"\n'),
        'codex features list': okResult('hooks stable true\nplugin_hooks under development false\n'),
        'codex login status': okResult('Logged in using ChatGPT\n'),
        'codex plugin marketplace --help': okResult(''),
      }),
    });
    strictEqual(report.readiness.claude_to_codex.sandbox_permission.status, 'unknown');
    strictEqual(report.readiness.codex_to_claude.sandbox_permission.status, 'unknown');
    strictEqual(report.sandbox_permission_probe.requested, false);
    strictEqual(report.sandbox_permission_probe.executed, false);
    strictEqual(report.permission_proof.requested, false);
    strictEqual(report.permission_proof.executed, false);
  });

  it('runs sandbox permission proof as an explicit read-only probe without peer execution', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-doctor-sandbox-probe-'));
    const home = await mkdtemp(join(tmpdir(), 'runtime-doctor-home-'));
    await seedRepo(root);
    const report = await runDoctor({
      repoRoot: root,
      homeDir: home,
      sandboxPermissionProbe: true,
      runner: fakeRunner({
        'claude --version': okResult('2.1.140 (Claude Code)\n'),
        'claude --help': okResult('Usage: claude --print --no-session-persistence --model --effort --permission-mode --plugin-dir\nCommands:\n  auth status\n  plugin list\n'),
        'claude auth status': okResult(JSON.stringify({ loggedIn: true })),
        'claude plugin list': okResult(''),
        'codex --version': okResult('codex-cli 0.130.0\n'),
        'codex --help': okResult('Commands:\n  exec Run Codex non-interactively\n  login status\n  plugin marketplace\nOptions:\n  --model\n  --config\n  --cd\n  --sandbox\n  --ask-for-approval\n'),
        'codex exec --help': okResult('Usage: codex exec --cd <DIR> --model <MODEL> --config model_reasoning_effort=\"high\"\n'),
        'codex features list': okResult('hooks stable true\nplugin_hooks under development false\n'),
        'codex login status': okResult('Logged in using ChatGPT\n'),
        'codex plugin marketplace --help': okResult(''),
      }),
    });

    strictEqual(report.sandbox_permission_probe.requested, true);
    strictEqual(report.sandbox_permission_probe.executed, true);
    strictEqual(report.sandbox_permission_probe.peer_execution, false);
    strictEqual(report.sandbox_permission_probe.status, 'read_only_probe_passed');
    strictEqual(report.sandbox_permission_probe.directions.claude_to_codex.status, 'read_only_probe_passed');
    strictEqual(report.sandbox_permission_probe.directions.codex_to_claude.status, 'read_only_probe_passed');
    strictEqual(report.readiness.claude_to_codex.sandbox_permission.status, 'read_only_probe_passed');
    strictEqual(report.readiness.codex_to_claude.sandbox_permission.peer_execution, false);
    ok(report.sandbox_permission_probe.directions.codex_to_claude.probes.some((probe) => probe.name === 'peer_permission_surface' && probe.status === 'passed'));
    ok(report.sandbox_permission_probe.limits.some((limit) => /does not execute peer agents/i.test(limit)));
    ok(formatText(report).includes('Sandbox Permission Probe'));
    ok(formatText(report).includes('peer-execution=false'));
  });

  it('plans permission proof as an explicit preflight without executing peers', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-doctor-permission-proof-'));
    const home = await mkdtemp(join(tmpdir(), 'runtime-doctor-home-'));
    await seedRepo(root);
    const report = await runDoctor({
      repoRoot: root,
      homeDir: home,
      explicitModel: 'gpt-5.4',
      explicitEffort: 'high',
      permissionProof: true,
      runner: fakeRunner(defaultRuntimeProbeMap()),
    });

    strictEqual(report.permission_proof.mode, 'plan_only_preflight');
    strictEqual(report.permission_proof.requested, true);
    strictEqual(report.permission_proof.executed, false);
    strictEqual(report.permission_proof.peer_execution, false);
    strictEqual(report.permission_proof.status, 'ready_with_warnings');
    strictEqual(report.permission_proof.directions.claude_to_codex.execution, 'not_executed');
    strictEqual(report.permission_proof.directions.claude_to_codex.preflight.status, 'read_only_probe_passed');
    strictEqual(report.permission_proof.directions.codex_to_claude.permission_policy.relaxed_by_doctor, false);
    ok(report.permission_proof.directions.codex_to_claude.warnings.some((warning) => /does not add sandbox/i.test(warning)));
    ok(report.permission_proof.limits.some((limit) => /does not execute peer agents/i.test(limit)));
    ok(formatText(report).includes('Permission Proof'));
    ok(formatText(report).includes('permission-policy: host-default=true; relaxed-by-doctor=false; injected-flags=0'));
  });

  it('executes permission proof only behind the explicit executor boundary and classifies permission failures', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-doctor-permission-proof-execute-'));
    const home = await mkdtemp(join(tmpdir(), 'runtime-doctor-home-'));
    await seedRepo(root);
    const calls = [];
    const permissionFailureEnvelope = {
      status: 'peer_error',
      peer_host: 'claude',
      peer_model: null,
      stdout: 'RUNTIME_DOCTOR_PERMISSION_RAW_DETAILS_MUST_NOT_LEAK',
      exit_code: 1,
      error: {
        kind: 'peer_permission_denied',
        message: 'Permission denied: sandbox approval required',
      },
      metadata: {
        duration_ms: 777,
        started_at: '2026-05-13T00:00:00.000Z',
        completed_at: '2026-05-13T00:00:01.000Z',
      },
    };
    const report = await runDoctor({
      repoRoot: root,
      homeDir: home,
      explicitModel: 'gpt-5.4',
      explicitEffort: 'high',
      permissionProof: true,
      executePermissionProof: true,
      permissionProofTimeoutMs: 45000,
      runner: async (command, args, options = {}) => {
        calls.push({ command, args, options });
        if (args[0]?.endsWith('codex-companion.mjs')) {
          strictEqual(options.timeoutMs, 45000);
          return okResult(JSON.stringify(smokeEnvelope('codex', 'RUNTIME_DOCTOR_PERMISSION_OK codex\nRAW DETAILS MUST NOT LEAK', 321)));
        }
        if (args[0]?.endsWith('claude-companion.mjs')) {
          strictEqual(options.timeoutMs, 45000);
          return {
            ok: false,
            exit_code: 1,
            stdout: JSON.stringify(permissionFailureEnvelope),
            stderr: 'EACCES',
            error_code: null,
            timed_out: false,
          };
        }
        return fakeRuntimeProbeRunner(command, args);
      },
    });

    strictEqual(report.permission_proof.mode, 'explicit_permission_executor');
    strictEqual(report.permission_proof.executed, true);
    strictEqual(report.permission_proof.peer_execution, true);
    strictEqual(report.permission_proof.status, 'partially_failed');
    strictEqual(report.overall.status, 'fail');
    strictEqual(report.permission_proof.directions.claude_to_codex.execution, 'executed');
    strictEqual(report.permission_proof.directions.claude_to_codex.result.status, 'passed');
    strictEqual(report.permission_proof.directions.codex_to_claude.result.status, 'permission_failed');
    strictEqual(report.permission_proof.directions.codex_to_claude.result.permission_failure, true);
    strictEqual(report.permission_proof.directions.codex_to_claude.result.permission_failure_kind, 'approval_required');
    ok(calls.some((call) => call.args[0]?.endsWith('codex-companion.mjs') && call.args.includes('--output-format') && call.args.includes('json')));
    ok(calls.some((call) => call.args[0]?.endsWith('claude-companion.mjs')));
    for (const call of calls.filter((entry) => entry.args[0]?.endsWith('codex-companion.mjs') || entry.args[0]?.endsWith('claude-companion.mjs'))) {
      ok(!call.args.includes('--sandbox'));
      ok(!call.args.includes('--ask-for-approval'));
      ok(!call.args.includes('--permission-mode'));
    }

    const serialized = JSON.stringify(report);
    ok(!serialized.includes('RAW DETAILS MUST NOT LEAK'), 'doctor report must not include raw peer stdout');
    ok(!serialized.includes('RUNTIME_DOCTOR_PERMISSION_RAW_DETAILS_MUST_NOT_LEAK'), 'doctor report must not include raw failed peer stdout');
    ok(formatText(report).includes('permission-failure=true'));
    ok(formatText(report).includes('permission-failure-kind: approval_required'));
  });

  it('plans deep peer smoke as a structured read-only doctor section without executing peers', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-doctor-deep-smoke-'));
    const home = await mkdtemp(join(tmpdir(), 'runtime-doctor-home-'));
    await seedRepo(root);
    const report = await runDoctor({
      repoRoot: root,
      homeDir: home,
      explicitModel: 'gpt-5.4',
      explicitEffort: 'high',
      deepPeerSmoke: true,
      runner: fakeRunner({
        'claude --version': okResult('2.1.140 (Claude Code)\n'),
        'claude --help': okResult('Usage: claude --print --no-session-persistence --model --effort --permission-mode --plugin-dir\nCommands:\n  auth status\n  plugin list\n'),
        'claude auth status': okResult(JSON.stringify({ loggedIn: true })),
        'claude plugin list': okResult(''),
        'codex --version': okResult('codex-cli 0.130.0\n'),
        'codex --help': okResult('Commands:\n  exec Run Codex non-interactively\n  login status\n  plugin marketplace\nOptions:\n  --model\n  --config\n  --cd\n  --sandbox\n  --ask-for-approval\n'),
        'codex exec --help': okResult('Usage: codex exec --cd <DIR> --model <MODEL> --config model_reasoning_effort=\"high\"\n'),
        'codex features list': okResult('hooks stable true\nplugin_hooks under development false\n'),
        'codex login status': okResult('Logged in using ChatGPT\n'),
        'codex plugin marketplace --help': okResult(''),
      }),
    });

    strictEqual(report.deep_peer_smoke.mode, 'plan_only_preflight');
    strictEqual(report.deep_peer_smoke.requested, true);
    strictEqual(report.deep_peer_smoke.executed, false);
    strictEqual(report.deep_peer_smoke.status, 'ready_with_warnings');
    strictEqual(report.deep_peer_smoke.directions.claude_to_codex.execution, 'not_executed');
    strictEqual(report.deep_peer_smoke.directions.claude_to_codex.model.value, 'gpt-5.4');
    strictEqual(report.deep_peer_smoke.directions.codex_to_claude.effort.value, 'high');
    ok(report.deep_peer_smoke.limits.some((limit) => /does not execute peer agents/i.test(limit)));
    ok(formatText(report).includes('Deep Peer Smoke'));
    ok(formatText(report).includes('plan-only preflight'));
  });

  it('executes deep peer smoke only behind the explicit executor boundary and omits raw peer output', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-doctor-deep-smoke-execute-'));
    const home = await mkdtemp(join(tmpdir(), 'runtime-doctor-home-'));
    await seedRepo(root);
    const peerOutputs = {
      codex: 'RUNTIME_DOCTOR_SMOKE_OK codex\nRAW DETAILS MUST NOT LEAK',
      claude: 'RUNTIME_DOCTOR_SMOKE_OK claude\nRAW DETAILS MUST NOT LEAK',
    };
    const calls = [];
    const report = await runDoctor({
      repoRoot: root,
      homeDir: home,
      explicitModel: 'gpt-5.4',
      explicitEffort: 'high',
      deepPeerSmoke: true,
      executeDeepPeerSmoke: true,
      deepPeerSmokeTimeoutMs: 90000,
      runner: async (command, args, options = {}) => {
        calls.push({ command, args, options });
        if (args[0]?.endsWith('codex-companion.mjs')) {
          strictEqual(options.timeoutMs, 90000);
          return okResult(JSON.stringify(smokeEnvelope('codex', peerOutputs.codex, 321)));
        }
        if (args[0]?.endsWith('claude-companion.mjs')) {
          strictEqual(options.timeoutMs, 90000);
          return okResult(JSON.stringify(smokeEnvelope('claude', peerOutputs.claude, 654)));
        }
        return fakeRuntimeProbeRunner(command, args);
      },
    });

    strictEqual(report.deep_peer_smoke.mode, 'explicit_executor');
    strictEqual(report.deep_peer_smoke.executed, true);
    strictEqual(report.deep_peer_smoke.peer_execution, true);
    strictEqual(report.deep_peer_smoke.status, 'passed');
    strictEqual(report.overall.status, 'warning');
    strictEqual(report.deep_peer_smoke.directions.claude_to_codex.execution, 'executed');
    strictEqual(report.deep_peer_smoke.directions.claude_to_codex.result.peer_host, 'codex');
    strictEqual(report.deep_peer_smoke.directions.claude_to_codex.result.expected_token_present, true);
    strictEqual(report.deep_peer_smoke.directions.claude_to_codex.result.stdout_bytes, Buffer.byteLength(peerOutputs.codex));
    ok(report.deep_peer_smoke.directions.claude_to_codex.result.stdout_sha256);
    ok(calls.some((call) => call.args[0]?.endsWith('codex-companion.mjs') && call.args.includes('--output-format') && call.args.includes('json')));
    ok(calls.some((call) => call.args[0]?.endsWith('claude-companion.mjs')));

    const serialized = JSON.stringify(report);
    ok(!serialized.includes('RAW DETAILS MUST NOT LEAK'), 'doctor report must not include raw peer stdout');
    ok(!formatText(report).includes('RAW DETAILS MUST NOT LEAK'), 'text report must not include raw peer stdout');
    ok(formatText(report).includes('peer-execution=true'));
  });

  it('parses CLI arguments and rejects unknown or malformed flags', () => {
    const opts = parseArgs(['--repo-root', '/tmp/repo', '--format', 'json', '--host', 'codex', '--model', 'm', '--effort', 'high', '--deep-peer-smoke', '--execute-deep-peer-smoke', '--deep-peer-smoke-timeout-ms', '90000', '--sandbox-permission-probe', '--permission-proof', '--execute-permission-proof', '--permission-proof-timeout-ms', '45000']);
    strictEqual(opts.repoRoot, '/tmp/repo');
    strictEqual(opts.format, 'json');
    strictEqual(opts.host, 'codex');
    strictEqual(opts.explicitModel, 'm');
    strictEqual(opts.explicitEffort, 'high');
    strictEqual(opts.deepPeerSmoke, true);
    strictEqual(opts.executeDeepPeerSmoke, true);
    strictEqual(opts.deepPeerSmokeTimeoutMs, 90000);
    strictEqual(opts.sandboxPermissionProbe, true);
    strictEqual(opts.permissionProof, true);
    strictEqual(opts.executePermissionProof, true);
    strictEqual(opts.permissionProofTimeoutMs, 45000);
    rejects(async () => parseArgs(['--format', 'xml']), /--format must be text or json/);
    rejects(async () => parseArgs(['--execute-deep-peer-smoke']), /requires --deep-peer-smoke/);
    rejects(async () => parseArgs(['--execute-permission-proof']), /requires --permission-proof/);
    rejects(async () => parseArgs(['--deep-peer-smoke', '--deep-peer-smoke-timeout-ms', '0']), /positive integer/);
    rejects(async () => parseArgs(['--permission-proof', '--permission-proof-timeout-ms', '0']), /positive integer/);
  });
});

function okResult(stdout = '', stderr = '') {
  return { ok: true, exit_code: 0, stdout, stderr, error_code: null, timed_out: false };
}

function enoent(command) {
  return {
    ok: false,
    exit_code: null,
    stdout: '',
    stderr: '',
    error_code: 'ENOENT',
    error_message: `spawn ${command} ENOENT`,
    timed_out: false,
  };
}

function fakeRunner(map) {
  return async (command, args) => {
    const key = `${command} ${args.join(' ')}`;
    return map[key] ?? enoent(command);
  };
}

function defaultRuntimeProbeMap() {
  return {
    'claude --version': okResult('2.1.140 (Claude Code)\n'),
    'claude --help': okResult('Usage: claude --print --no-session-persistence --model --effort --permission-mode --plugin-dir\nCommands:\n  auth status\n  plugin list\n'),
    'claude auth status': okResult(JSON.stringify({ loggedIn: true })),
    'claude plugin list': okResult(''),
    'codex --version': okResult('codex-cli 0.130.0\n'),
    'codex --help': okResult('Commands:\n  exec Run Codex non-interactively\n  login status\n  plugin marketplace\nOptions:\n  --model\n  --config\n  --cd\n  --sandbox\n  --ask-for-approval\n'),
    'codex exec --help': okResult('Usage: codex exec --cd <DIR> --model <MODEL> --config model_reasoning_effort="high"\n'),
    'codex features list': okResult('hooks stable true\nplugin_hooks under development false\nplugins stable true\nmulti_agent stable true\n'),
    'codex login status': okResult('Logged in using ChatGPT\n'),
    'codex plugin marketplace --help': okResult(''),
  };
}

function fakeRuntimeProbeRunner(command, args) {
  return fakeRunner(defaultRuntimeProbeMap())(command, args);
}

function smokeEnvelope(peer, stdout, durationMs) {
  return {
    status: 'success',
    peer_host: peer,
    peer_model: null,
    stdout,
    exit_code: 0,
    metadata: {
      duration_ms: durationMs,
      started_at: '2026-05-13T00:00:00.000Z',
      completed_at: '2026-05-13T00:00:01.000Z',
    },
  };
}

async function seedRepo(root) {
  for (const name of ['companions', 'engineer', 'orchestrator', 'runtime']) {
    await mkdir(join(root, 'plugins', name, '.claude-plugin'), { recursive: true });
    await mkdir(join(root, 'plugins', name, '.codex-plugin'), { recursive: true });
    await writeJson(join(root, 'plugins', name, '.claude-plugin', 'plugin.json'), {
      name,
      version: name === 'runtime' ? '0.1.0' : '1.0.0',
      description: `${name} plugin`,
    });
    await writeJson(join(root, 'plugins', name, '.codex-plugin', 'plugin.json'), {
      name,
      version: name === 'runtime' ? '0.1.0' : '1.0.0',
      description: `${name} plugin`,
    });
  }
  await mkdir(join(root, 'companions'), { recursive: true });
  await writeFile(join(root, 'companions', 'contract.md'), '**Version**: `v0.1.1`\n');
  await writeFile(join(root, 'companions', 'codex-companion.mjs'), "const CONTRACT_VERSION = '0.1.1'; // --prompt-file\n");
  await writeFile(join(root, 'companions', 'claude-companion.mjs'), "const CONTRACT_VERSION = '0.1.1'; // --prompt-file\n");
  await mkdir(join(root, 'plugins', 'companions', 'scripts'), { recursive: true });
  await writeFile(join(root, 'plugins', 'companions', 'scripts', 'codex-companion.mjs'), "const CONTRACT_VERSION = '0.1.1'; // --prompt-file\n");
  await writeFile(join(root, 'plugins', 'companions', 'scripts', 'claude-companion.mjs'), "const CONTRACT_VERSION = '0.1.1'; // --prompt-file\n");
  await mkdir(join(root, '.claude-plugin'), { recursive: true });
  await writeJson(join(root, '.claude-plugin', 'marketplace.json'), {
    name: 'agentic-plugins',
    description: 'test',
    plugins: ['companions', 'engineer', 'orchestrator', 'runtime'].map((name) => ({
      name,
      source: `./plugins/${name}`,
      version: name === 'runtime' ? '0.1.0' : '1.0.0',
      category: 'Productivity',
    })),
  });
  await mkdir(join(root, '.agents', 'plugins'), { recursive: true });
  await writeJson(join(root, '.agents', 'plugins', 'marketplace.json'), {
    name: 'agentic-plugins',
    description: 'test',
    plugins: ['companions', 'engineer', 'orchestrator', 'runtime'].map((name) => ({
      name,
      source: { source: 'local', path: `./plugins/${name}` },
      policy: { installation: 'AVAILABLE', authentication: 'ON_USE' },
      category: 'Productivity',
    })),
  });
  await mkdir(join(root, '.agentic-plugins'), { recursive: true });
  await writeFile(join(root, '.agentic-plugins', 'config.toml'), 'codex_model = "repo-codex"\nclaude_effort = "medium"\n');
  await mkdir(join(root, '.claude', 'agentic-engineer', 'workflows'), { recursive: true });
  await writeFile(join(root, '.claude', 'agentic-engineer', 'workflows', 'compose-20260513T000000Z-abcdef.md'), [
    '---',
    'workflow_id: compose-20260513T000000Z-abcdef',
    'current_phase: phase-4',
    'git_baseline:',
    '  branch: feat/runtime-doctor',
    '---',
    '',
  ].join('\n'));
  await mkdir(join(root, '.claude', 'agentic-engineer', 'peer-runs', 'run-1'), { recursive: true });
  await writeJson(join(root, '.claude', 'agentic-engineer', 'peer-runs', 'run-1', 'handle.json'), {
    run_id: 'run-1',
    plugin: 'engineer',
    status: 'running',
    kind: 'ensemble',
    peer_host: 'claude',
    model: 'm',
    effort: 'high',
    updated_at: '2026-05-12T23:00:00.000Z',
  });
}

async function seedHome(home) {
  await mkdir(join(home, '.codex', 'plugins', 'cache', 'agentic-plugins', 'runtime', '0.1.0', '.codex-plugin'), { recursive: true });
  await writeJson(join(home, '.codex', 'plugins', 'cache', 'agentic-plugins', 'runtime', '0.1.0', '.codex-plugin', 'plugin.json'), {
    name: 'runtime',
    version: '0.1.0',
  });
}

async function seedCodexTmpMarketplace(home) {
  await mkdir(join(home, '.codex', '.tmp', 'marketplaces', 'agentic-plugins', 'plugins', 'runtime', '.codex-plugin'), { recursive: true });
  await writeJson(join(home, '.codex', '.tmp', 'marketplaces', 'agentic-plugins', 'plugins', 'runtime', '.codex-plugin', 'plugin.json'), {
    name: 'runtime',
    version: '0.1.0',
  });
}

async function writeWorkflow(path, branch) {
  await writeFile(path, [
    '---',
    `workflow_id: ${path.split('/').at(-1).replace(/\.md$/, '')}`,
    'current_phase: phase-4',
    'git_baseline:',
    `  branch: ${branch}`,
    '---',
    '',
  ].join('\n'));
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}
