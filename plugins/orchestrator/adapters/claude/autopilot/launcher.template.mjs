#!/usr/bin/env node
// agentic-autopilot — the optional terminal launcher of the agentic-plugins
// autopilot (ADR-0063 D2, owner decision D13).
//
// The owner installs this file, as shipped, to
// ~/.agentic-plugins/bin/agentic-autopilot (`/orchestrator:autopilot preview`
// prints the command). Nothing installs it for the owner, and no plugin ever
// runs it. It only finds the installed orchestrator and hands it the command
// line, so upgrading the plugin upgrades the autopilot without reinstalling
// this file (the receiver template pattern, plugins/runtime/scripts/receiver-api.mjs).
//
//   AGENTIC_ORCHESTRATOR_ROOT, when set, names the orchestrator to run;
//   otherwise the newest orchestrator in Claude Code's plugin cache whose
//   manifest names it and that ships the autopilot entry.
//
// A terminal is where a run longer than a Claude session's background-task
// limit (two hours) belongs.

import { spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ENTRY = ['adapters', 'claude', 'autopilot', 'cli.mjs'];
const RELEASE_DIR = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

function newer(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i += 1) if (pa[i] !== pb[i]) return pa[i] > pb[i];
  return false;
}

export function findOrchestrator(env = process.env, home = homedir()) {
  const override = env.AGENTIC_ORCHESTRATOR_ROOT;
  if (typeof override === 'string' && override.length > 0) {
    if (isAbsolute(override) && existsSync(join(override, ...ENTRY))) return { root: override };
    return { error: `AGENTIC_ORCHESTRATOR_ROOT=${override} is not an absolute orchestrator root that ships ${ENTRY.join('/')}` };
  }
  const base = join(home, '.claude', 'plugins', 'cache', 'agentic-plugins', 'orchestrator');
  let best = null;
  let names = [];
  try { names = readdirSync(base); } catch { /* no cache */ }
  for (const name of names) {
    if (!RELEASE_DIR.test(name)) continue;
    const root = join(base, name);
    let manifest;
    try { manifest = JSON.parse(readFileSync(join(root, '.claude-plugin', 'plugin.json'), 'utf8')); } catch { continue; }
    if (manifest?.name !== 'orchestrator' || !existsSync(join(root, ...ENTRY))) continue;
    if (!best || newer(name, best.version)) best = { root, version: name };
  }
  if (!best) return { error: `no orchestrator in ${base} ships the autopilot; install or update orchestrator for Claude Code` };
  return { root: best.root };
}

function main() {
  const found = findOrchestrator();
  if (found.error) {
    process.stderr.write(`agentic-autopilot: ${found.error}\n`);
    process.exit(1);
  }
  const child = spawn(process.execPath, [join(found.root, ...ENTRY), ...process.argv.slice(2)], { stdio: 'inherit' });
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => { try { child.kill(signal); } catch { /* gone */ } });
  }
  child.on('error', (e) => {
    process.stderr.write(`agentic-autopilot: ${e.message}\n`);
    process.exit(1);
  });
  child.on('exit', (code, signal) => {
    process.exit(code ?? (signal === 'SIGINT' ? 130 : signal === 'SIGTERM' ? 143 : 1));
  });
}

// Run only when this file is the program (the installed executable, or the
// template run by hand), never when a test imports it. Node 24 runs the
// extensionless installed copy as ESM by syntax detection.
function isProgram() {
  try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
}
if (process.argv[1] && isProgram()) main();
