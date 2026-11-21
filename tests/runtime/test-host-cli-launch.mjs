// C180: runtime starts `claude` and `codex` the way the companions do
// (plugins/runtime/scripts/lib/host-cli-launch.mjs over its copy of
// companions/peer-cli.mjs). The resolver's own cases are covered beside the
// companions (companions/tests/peer-cli.test.mjs); these hold what runtime adds:
// the launch as data, and doctor's runCommand spawning exactly the launch it is
// handed, or nothing when the CLI cannot be resolved.

import { describe, it } from 'node:test';
import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict';
import { join } from 'node:path';

import { runCommand } from '../../plugins/runtime/scripts/doctor.mjs';
import { launchArgv, resolveHostLaunch, resolveHostLaunches } from '../../plugins/runtime/scripts/lib/host-cli-launch.mjs';
import { tmpDir } from '../_tmp.mjs';

describe('runtime host CLI launch (C180)', () => {
  it('resolves to the bare name off Windows with no override, as before', () => {
    const launches = resolveHostLaunches({ env: { PATH: '/usr/bin' }, platform: 'linux' });
    for (const name of ['claude', 'codex']) {
      deepStrictEqual(launchArgv(launches[name]), [name]);
      strictEqual(launches[name].source, 'bare');
    }
  });

  it('turns an override that names nothing into a failure naming the variable', (t) => {
    const dir = tmpDir(t, 'runtime-host-cli-launch-');
    const launch = resolveHostLaunch('claude', { env: { CLAUDE_BIN: join(dir, 'missing') }, platform: 'linux' });
    strictEqual(launch.ok, false);
    strictEqual(launch.variable, 'CLAUDE_BIN');
    ok(launch.reason.includes('CLAUDE_BIN='), launch.reason);
    strictEqual(launchArgv(launch), null);
  });

  it('redacts a secret pasted into an override from the reason every report keeps', () => {
    const token = `sk-ant-${'x'.repeat(24)}`;
    const launch = resolveHostLaunch('codex', { env: { CODEX_BIN: `/nope/${token}` }, platform: 'linux' });
    strictEqual(launch.ok, false);
    ok(!launch.reason.includes(token), launch.reason);
    ok(launch.reason.includes('<redacted-token>'), launch.reason);
  });

  it('runCommand spawns the launch it is handed, prefix first, in place of the bare name', async () => {
    const launch = { command: process.execPath, args_prefix: ['-e', 'process.stdout.write(JSON.stringify(process.argv.slice(1)))'] };
    const result = await runCommand('codex', ['plugin', 'list'], { launch, env: { ...process.env, CODEX_BIN: '/nonexistent/codex' } });
    strictEqual(result.ok, true, result.stderr || result.error_message);
    deepStrictEqual(JSON.parse(result.stdout), ['plugin', 'list'], 'the handed launch wins over a later resolution');
  });

  it('runCommand spawns nothing for a host CLI it cannot resolve, and says why', async (t) => {
    const dir = tmpDir(t, 'runtime-host-cli-launch-');
    const missing = join(dir, 'codex');
    const result = await runCommand('codex', ['--version'], { env: { ...process.env, CODEX_BIN: missing } });
    strictEqual(result.ok, false);
    strictEqual(result.exit_code, null, 'no process ran');
    strictEqual(result.error_code, 'peer_cli_not_found');
    deepStrictEqual(result.launch_failure.variable, 'CODEX_BIN');
    ok(result.error_message.includes(`CODEX_BIN=${missing} names no file`), result.error_message);
  });

  it('runCommand leaves any other command alone', async () => {
    const result = await runCommand(process.execPath, ['-e', 'process.stdout.write("ok")'], { env: { ...process.env, CODEX_BIN: '/nonexistent/codex', CLAUDE_BIN: '/nonexistent/claude' } });
    strictEqual(result.stdout, 'ok');
  });
});
