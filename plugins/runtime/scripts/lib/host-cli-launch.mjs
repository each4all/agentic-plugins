// How runtime starts the host CLIs, `claude` and `codex` (C180): the same
// resolution the companions use (lib/peer-cli.mjs, a copy of
// companions/peer-cli.mjs), so a CODEX_BIN / CLAUDE_BIN override and a Windows
// npm .cmd shim are honored by doctor's probes, settings' plugin commands and
// the companions alike.
//
// A launch is plain data, `{ command, args_prefix, source, shim }`, spawned as
// spawn(command, [...args_prefix, ...args]); a failure is
// `{ ok: false, variable, reason, detail }`, whose reason names the variable
// to set. Resolution reads the filesystem and never a subprocess, so the
// settings planner stays pure: settings resolves once and hands the planner
// the launches as data, as it hands it the probed CLI facts.
//
// A command shown to the owner stays the logical one (`codex plugin add …`);
// the launch is recorded beside it, and the plan hash covers it, so an override
// or shim target that changes between the presented plan and its execution
// makes the executor refuse (machine-bootstrap-contract.md §1.6).

import { resolvePeerCli } from './peer-cli.mjs';
import { redactSecrets } from './sanitize.mjs';

export const HOST_CLI_NAMES = Object.freeze(['claude', 'codex']);
export const HOST_CLI_NOT_FOUND = 'peer_cli_not_found';

export function isHostCli(name) {
  return HOST_CLI_NAMES.includes(name);
}

// An override path is resolved against the caller's own working directory,
// where the operator wrote it, never against a probe's neutral cwd.
export function resolveHostLaunch(name, { env = process.env, platform = process.platform, cwd = process.cwd(), execPath = process.execPath, fs } = {}) {
  const resolved = resolvePeerCli(name, { env, platform, cwd, execPath, ...(fs ? { fs } : {}) });
  const variable = name === 'claude' ? 'CLAUDE_BIN' : 'CODEX_BIN';
  if (!resolved.ok) {
    // The message quotes the override's value, which a report and a settings
    // artifact keep: redacted here, so no reader shows a secret pasted into it.
    return {
      ok: false,
      name,
      variable,
      reason: redactSecrets(resolved.message),
      detail: resolved.detail == null ? null : redactSecrets(resolved.detail),
    };
  }
  return {
    ok: true,
    name,
    command: resolved.command,
    args_prefix: [...resolved.argsPrefix],
    source: resolved.source,
    shim: resolved.shim ?? null,
  };
}

export function resolveHostLaunches(options = {}) {
  return Object.fromEntries(HOST_CLI_NAMES.map((name) => [name, resolveHostLaunch(name, options)]));
}

// The argv a launch hashes and spawns as: its command, then its prefix.
export function launchArgv(launch) {
  if (!launch?.ok) return null;
  return [launch.command, ...launch.args_prefix];
}

// The result a runner returns for a host CLI it could not resolve: no process
// ran, so exit_code is null, and the reason, which names the variable to set,
// is the message every reader shows.
export function unresolvedLaunchResult(launch) {
  return {
    ok: false,
    exit_code: null,
    stdout: '',
    stderr: '',
    error_code: HOST_CLI_NOT_FOUND,
    error_message: launch.reason,
    launch_failure: { variable: launch.variable, reason: launch.reason },
    timed_out: false,
  };
}
