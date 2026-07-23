#!/usr/bin/env node
// agentic-statusline.mjs — Claude Code statusLine shim for agentic-plugins
// (rendered by the runtime:bootstrap statusline plan, ADR-0048 §2/§2.1).
//
// Source template: plugins/runtime/receivers/agentic-statusline.mjs. It ships
// with the runtime plugin as render-input DATA, deliberately outside
// plugins/runtime/scripts/: the ADR-0035 §4 executor guard governs code the
// runtime itself executes, and runtime never imports or spawns this shim —
// the plan renders it into an artifact and the USER installs and runs it
// (canonical home: ~/.agentic-plugins/bin/agentic-statusline.mjs, invoked by
// Claude Code as `node "<path>"` per the settings statusLine fragment).
//
// Contract (ADR-0048 §2, the shim half of the sufficiency gate): read-only,
// bounded, credential-free, network-free, non-polling, order-preserving under
// missing data. Claude Code writes one session JSON document on stdin and
// displays the first stdout line; triggers are host-driven (never a timer
// here). Fail-closed silent: exit 0 always, at most one plain line on stdout,
// nothing on stderr beyond one diagnostic.
//
// The ITEM ORDER is rendered in from the one canonical policy
// (lib/statusline-plan.mjs, ADR-0048 §2.1 — the owner-adopted agentic-6 set);
// this shim owns only the per-item projections. A policy item this shim does
// not know is skipped (order preserved), never an error — and the plan-side
// test pins that the policy ids and this renderer map agree, so drift fails
// the suite rather than the statusline.
//
// Git branch (ADR-0048 realization decision, owner-approved 2026-07-23): an
// ordinary Claude session's stdin carries no branch (worktree.branch is
// --worktree-session only), so this shim runs ONE bounded read-only
// `git branch --show-current` — fixed argv, no shell, cwd validated from the
// session JSON, 1.5s timeout, capped output, scrubbed child environment.
// That stays inside the §2 shim contract (read-only + bounded; the contract
// forbids network/credentials/polling, not a read-only VCS query); the
// §2.1 "from its stdin JSON" wording predates this decision and the
// machine-bootstrap contract records the deviation.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';

const STATUSLINE_ITEMS = ['__AGENTIC_STATUSLINE_ITEMS__'];

const STDIN_MAX_BYTES = 256 * 1024;
const GIT_TIMEOUT_MS = 1500;
const SEGMENT_MAX_CHARS = 64;

function readStdinBounded() {
  try {
    const text = fs.readFileSync(0, 'utf8');
    if (Buffer.byteLength(text, 'utf8') > STDIN_MAX_BYTES) return null;
    return text;
  } catch {
    return null;
  }
}

// One plain-text segment: strip control/ANSI/newlines, cap length. The
// statusline is a single terminal line — a hostile or odd value must not be
// able to break out of it.
function sanitizeSegment(value) {
  const text = String(value)
    .replace(/\u001b\[[0-9;]*[A-Za-z]/g, '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > SEGMENT_MAX_CHARS ? `${text.slice(0, SEGMENT_MAX_CHARS - 1)}…` : text;
}

function finitePercent(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > 999) return null;
  return Math.round(n);
}

function gitBranchFallback(data) {
  const cwd = typeof data?.workspace?.current_dir === 'string' ? data.workspace.current_dir
    : typeof data?.cwd === 'string' ? data.cwd
      : null;
  if (!cwd) return null;
  let stat;
  try { stat = fs.statSync(cwd); } catch { return null; }
  if (!stat.isDirectory()) return null;
  // Scrubbed child environment: PATH/HOME only — no credential-shaped variable
  // reaches the git child (ADR-0048 §4 spawn-scrub discipline).
  const env = {};
  if (process.env.PATH) env.PATH = process.env.PATH;
  if (process.env.HOME) env.HOME = process.env.HOME;
  if (process.env.SYSTEMROOT) env.SYSTEMROOT = process.env.SYSTEMROOT;
  try {
    const result = spawnSync('git', ['branch', '--show-current'], {
      cwd,
      env,
      shell: false,
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: 4096,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    if (result.status !== 0 || typeof result.stdout !== 'string') return null;
    const branch = result.stdout.trim();
    return branch.length > 0 ? branch : null;
  } catch {
    return null;
  }
}

// Per-item projections over the Claude session JSON (ADR-0048 §2.1 field
// mapping). Each returns a rendered segment string, or null to SKIP the item
// (order preserved — §2's order-preserving-under-missing-data rule).
const RENDERERS = {
  'model-with-reasoning': (data) => {
    const model = typeof data?.model?.display_name === 'string' ? data.model.display_name : null;
    if (!model) return null;
    const effort = typeof data?.effort?.level === 'string' ? data.effort.level : null;
    return sanitizeSegment(effort ? `${model} ${effort}` : model);
  },
  'git-branch': (data) => {
    const worktree = typeof data?.worktree?.branch === 'string' && data.worktree.branch.length > 0 ? data.worktree.branch : null;
    const branch = worktree ?? gitBranchFallback(data);
    return branch ? sanitizeSegment(branch) : null;
  },
  'pull-request-number': (data) => {
    const pr = data?.pr?.number;
    const n = Number(pr);
    return Number.isInteger(n) && n > 0 ? `PR#${n}` : null;
  },
  'context-used': (data) => {
    const pct = finitePercent(data?.context_window?.used_percentage);
    return pct === null ? null : `ctx ${pct}%`;
  },
  'five-hour-limit': (data) => {
    const pct = finitePercent(data?.rate_limits?.five_hour?.used_percentage);
    return pct === null ? null : `5h ${pct}%`;
  },
  'weekly-limit': (data) => {
    const pct = finitePercent(data?.rate_limits?.seven_day?.used_percentage);
    return pct === null ? null : `wk ${pct}%`;
  },
};

function main() {
  const text = readStdinBounded();
  if (text === null) return;
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return;
  }
  const segments = [];
  for (const item of STATUSLINE_ITEMS) {
    const renderer = RENDERERS[item];
    if (!renderer) continue; // unknown policy item — skipped, order preserved
    let segment = null;
    try { segment = renderer(data); } catch { segment = null; }
    if (segment) segments.push(segment);
  }
  if (segments.length > 0) {
    try { process.stdout.write(`${segments.join(' · ')}\n`); } catch { /* EPIPE — host cancelled */ }
  }
}

main();
process.exit(0);
