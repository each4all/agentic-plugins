#!/usr/bin/env node
// codex-notify-chain.mjs — wrapper-chaining Codex notify= receiver
// (rendered by `runtime:settings --notification-plan`, ADR-0040 §4).
//
// Source template: plugins/runtime/receivers/codex-notify-chain.mjs. It
// ships with the runtime plugin as render-input DATA, deliberately outside
// plugins/runtime/scripts/: the ADR-0035 §4 executor guard governs code the
// runtime itself executes, and runtime never imports or spawns this receiver
// — the plan renders it into an artifact and the USER installs and runs it.
//
// The Codex `notify` key is a single-key FULL REPLACE, so pointing it at the
// agentic-plugins shuttle would silently drop the notifier you already had.
// This chain preserves it: on every notification it invokes your PRIOR
// notifier (embedded below exactly as it appeared in config.toml) and the
// agentic-plugins shuttle, both fire-and-forget. Codex appends the payload
// JSON as the last argv argument; the chain forwards it to both receivers.
//
// Fail-closed silent: exit 0 always, nothing on stdout, failures of either
// receiver are ignored (a notification must never break the Codex turn).

import { spawn } from 'node:child_process';

const PRIOR_NOTIFY = ["__AGENTIC_PRIOR_NOTIFY__"];
const SHUTTLE_PATH = "__AGENTIC_SHUTTLE_PATH__";

function fireAndForget(command, args) {
  try {
    const child = spawn(command, args, { stdio: 'ignore', detached: true });
    child.on('error', function () {});
    child.unref();
  } catch {}
}

function main() {
  const payload = process.argv.length > 2
    ? process.argv[process.argv.length - 1]
    : null;
  const withPayload = function (args) {
    return payload === null ? args : args.concat([payload]);
  };
  if (PRIOR_NOTIFY.length > 0) {
    fireAndForget(PRIOR_NOTIFY[0], withPayload(PRIOR_NOTIFY.slice(1)));
  }
  fireAndForget(process.execPath, withPayload([SHUTTLE_PATH]));
}

try { main(); } catch {}
process.exitCode = 0;
