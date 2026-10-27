// scripts/lib/hold-activation.mjs — when holds may turn on for a macro
// (ADR-0068 Decision 2, item 9; N2, N8).
//
// Holds work only with hold-aware code on both sides. The marker
// `protocol.json` tells the persona a hold-aware orchestrator runs for the
// macro; it is written before the first hold record and before a hold-aware
// run's first dispatch, and only once the persona release is installed where
// a person's session or a worker loads it: each host's engineer cache, probed
// strictly (that host's own newest version, no environment override, no
// fallback to the other host), and the engineer the autopilot launcher pins.
// A refusal names what to install or move. Completing hold-persona is not
// enough: a person's session loads its own engineer.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { HOLD_PERSONA_CAPABILITY, HOLDS_PROTOCOL, readActivation, writeProtocol } from './holds-records.mjs';

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:\+[0-9A-Za-z.-]+)?$/;

/** The newest version directory under a cache base, or null. */
function newestVersion(base) {
  let names;
  try { names = fs.readdirSync(base); } catch { return null; }
  const versions = names.map((n) => [n, SEMVER.exec(n)]).filter(([, m]) => m)
    .sort((a, b) => (a[1][1] - b[1][1]) || (a[1][2] - b[1][2]) || (a[1][3] - b[1][3]));
  return versions.length ? path.join(base, versions.at(-1)[0]) : null;
}

/** Each host's engineer cache: `{ claude, codex }`, each a directory or null. */
export function hostEngineerCaches({ env = process.env, home = env.HOME || os.homedir() } = {}) {
  const codexHome = typeof env.CODEX_HOME === 'string' && env.CODEX_HOME.length > 0 ? path.resolve(env.CODEX_HOME) : path.join(home, '.codex');
  return {
    claude: newestVersion(path.join(home, '.claude', 'plugins', 'cache', 'agentic-plugins', 'engineer')),
    codex: newestVersion(path.join(codexHome, 'plugins', 'cache', 'agentic-plugins', 'engineer')),
  };
}

/**
 * Whether an engineer root is hold-aware: its `state.mjs hold-capability`
 * prints `{ capability: 'hold-persona-1', protocol: 1 }`. `null`, or the
 * problem.
 */
export function engineerHoldProblem(root, { env = process.env } = {}) {
  if (!root) return 'no engineer is installed there';
  const r = spawnSync(process.execPath, [path.join(root, 'scripts', 'state.mjs'), 'hold-capability'], {
    encoding: 'utf8', timeout: 30_000, env: Object.fromEntries(Object.entries(env).filter(([k]) => !k.startsWith('AGENTIC_'))),
  });
  let out = null;
  try { out = JSON.parse((r.stdout ?? '').trim()); } catch { /* not JSON */ }
  if (r.status === 0 && out?.capability === HOLD_PERSONA_CAPABILITY && out?.protocol === HOLDS_PROTOCOL) return null;
  return `the engineer at ${root} is not hold-aware (state.mjs hold-capability does not print ${HOLD_PERSONA_CAPABILITY})`;
}

/**
 * Every reason holds may not turn on: each host's engineer cache and the
 * launcher's pinned engineer, each needing the hold-aware persona. `[]` when
 * none.
 */
export function holdActivationProblems({ pinnedEngineerRoot, env = process.env, home } = {}) {
  const caches = hostEngineerCaches({ env, ...(home ? { home } : {}) });
  const problems = [];
  for (const host of ['claude', 'codex']) {
    const p = engineerHoldProblem(caches[host], { env });
    if (p) problems.push(`${host === 'claude' ? 'Claude Code' : 'Codex CLI'}: ${p}; install the engineer release with the hold-aware persona (${HOLD_PERSONA_CAPABILITY}) on that host`);
  }
  const pinned = engineerHoldProblem(pinnedEngineerRoot, { env });
  if (pinned) problems.push(`the autopilot's pinned engineer: ${pinned}; move the launcher's pin (AGENTIC_ENGINEER_ROOT) to that release`);
  return problems;
}

/**
 * Turn holds on for a macro: `{ ok: true, written }` once the marker is there
 * (written now or already), or `{ ok: false, problems }` — a marker that
 * cannot be read (never overwritten), or a persona not yet installed.
 */
export function activateHolds({ mainRoot, macroId, pinnedEngineerRoot, env = process.env, home, writtenBy }) {
  const a = readActivation(mainRoot, macroId);
  if (a.state === 'active') return { ok: true, written: false };
  if (a.state === 'unreadable') return { ok: false, problems: [`the holds marker of ${macroId} cannot be read (${a.error}); it is not overwritten`] };
  const problems = holdActivationProblems({ pinnedEngineerRoot, env, ...(home ? { home } : {}) });
  if (problems.length) return { ok: false, problems };
  const w = writeProtocol(mainRoot, macroId, { writtenBy });
  return { ok: true, written: w.written };
}
