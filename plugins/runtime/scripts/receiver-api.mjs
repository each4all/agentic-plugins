#!/usr/bin/env node
// receiver-api.mjs — the stable packaged API that agentic-plugins' installed
// receiver delegates to (ADR-0048 §2 as amended).
//
// WHY THIS EXISTS. The receiver under plugins/runtime/receivers/ is a
// TEMPLATE: bootstrap renders it for ~/.agentic-plugins/bin/ and the USER
// installs and runs it. Whatever logic a rendered file carries is frozen at
// install time and cannot be updated by upgrading the plugin — the hazard the
// former Codex notify shuttle recorded in its own header, where an ADR-0047 §5
// mapping change left older installed shuttles emitting a superseded event
// kind. (ADR-0064 removed the shuttle, its chain receiver and the payload
// mapping they delegated here.)
//
// So the volatile behaviour lives HERE, in the plugin, and the installed file
// keeps only what must bootstrap: find the runtime, gate it, delegate.
//
// WHAT THIS MODULE MAY NOT DO. It is imported into the statusline shim's own
// process, so it inherits the ADR-0048 §2 shim contract in full: read-only,
// bounded, credential-free, network-free, non-polling, order-preserving under
// missing data, and side-effect-free on import. It must also stay
// dependency-light — the statusline renders synchronously on every prompt, and
// a heavy transitive import graph would be charged to that budget. Both
// properties are pinned by tests, not by this comment.
//
// This module is NOT an executor of installed bytes: delegation runs one way
// only (installed shim -> packaged plugin). Runtime still never imports or
// spawns anything out of ~/.agentic-plugins/bin, so the ADR-0035 §4 executor
// guard is untouched.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';

// Per-receiver capability majors, checked in ADDITION to the manifest version
// gate — a semver floor only proves which release answered, not that this build
// still provides the entry point the shim intends to call.
//
// A shim must require its major EXACTLY, never `>=`. The two are not
// interchangeable: a major is incremented precisely BECAUSE the old shape
// broke, so `resolved >= floor` would have a v1 shim accept the v2 runtime that
// broke it. Exact-match means an incompatible runtime reads as no runtime, and
// the shim fails closed instead of calling something whose contract it does not
// know.
//
// Each receiver is versioned SEPARATELY so a change to one does not force
// another's installed copies to be re-rendered. `codexNotify` went with the
// Codex notify receivers (ADR-0064 Decision 1): an installed shuttle resolves
// only a runtime that still carries `scripts/notify.mjs`, so this build is
// never the one it calls.
export const RECEIVER_API_MAJORS = Object.freeze({
  statusline: 1,
});

const STDIN_MAX_BYTES = 256 * 1024;
const GIT_TIMEOUT_MS = 1500;
const SEGMENT_MAX_CHARS = 64;

// One plain-text segment: strip control/ANSI/newlines, cap length. The
// statusline is a single terminal line — a hostile or odd value must not be
// able to break out of it.
function sanitizeSegment(value) {
  const text = String(value)
    .replace(/\u001b\[[0-9;]*[A-Za-z]/g, '')
    // C0 + DEL + C1 (Review peer MAJOR: U+009B CSI reached the terminal) and
    // bidi overrides/isolates (U+202A-E, U+2066-9, LRM/RLM) — a statusline
    // segment must not be able to reorder or restyle the line around it.
    .replace(/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, ' ')
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
  const raw = typeof data?.workspace?.current_dir === 'string' ? data.workspace.current_dir
    : typeof data?.cwd === 'string' ? data.cwd
      : null;
  if (!raw) return null;
  // cwd hardening (Review peer MAJOR): absolute local paths only — UNC and
  // //-prefixed paths can initiate network filesystem access on Windows, and
  // a relative path would resolve against whatever cwd the host launched the
  // shim from. realpath pins symlinked homes to their local target.
  if (raw.startsWith('\\\\') || raw.startsWith('//')) return null;
  if (!(raw.startsWith('/') || /^[A-Za-z]:[\\/]/.test(raw))) return null;
  let cwd;
  try { cwd = fs.realpathSync(raw); } catch { return null; }
  if (cwd.startsWith('\\\\') || cwd.startsWith('//')) return null;
  let stat;
  try { stat = fs.statSync(cwd); } catch { return null; }
  if (!stat.isDirectory()) return null;
  // Scrubbed child environment: PATH/HOME only — no credential-shaped variable
  // reaches the git child (ADR-0048 §4 spawn-scrub discipline).
  const env = {};
  if (process.env.PATH) env.PATH = process.env.PATH;
  if (process.env.HOME) env.HOME = process.env.HOME;
  if (process.env.SYSTEMROOT) env.SYSTEMROOT = process.env.SYSTEMROOT;
  env.GIT_OPTIONAL_LOCKS = '0';
  // The query inherits git's own semantics for exotic repositories (a .git
  // file pointing elsewhere follows git's rules) — the shim itself opens no
  // network connection; the contract states the boundary in those terms.
  env.GIT_TERMINAL_PROMPT = '0';
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

/**
 * Render one statusline text line from the Claude session JSON.
 *
 * `items` is the caller's ordered policy (the rendered shim carries the
 * owner-adopted set). An item this build does not know is SKIPPED with order
 * preserved — never an error — so a newer installed shim naming an item an
 * older runtime lacks degrades to a shorter line instead of no line at all.
 *
 * Returns the line, or null when nothing rendered (the shim then prints
 * nothing, which the host shows as an empty statusline).
 */
export function renderStatusline({ session, items } = {}) {
  if (!session || typeof session !== 'object') return null;
  if (!Array.isArray(items)) return null;
  const segments = [];
  for (const item of items) {
    const renderer = RENDERERS[item];
    if (!renderer) continue; // unknown policy item — skipped, order preserved
    let segment = null;
    try { segment = renderer(session); } catch { segment = null; }
    if (segment) segments.push(segment);
  }
  return segments.length > 0 ? segments.join(' \u00b7 ') : null;
}

/** The renderer ids this build supports — the policy-agreement test binds these to the plan policy. */
export function statuslineRendererIds() {
  return Object.keys(RENDERERS);
}

/** Bounded stdin read, for a receiver that consumes a host JSON document. */
export function readStdinBounded(fd = 0) {
  try {
    const chunks = [];
    let total = 0;
    const buf = Buffer.alloc(65536);
    for (;;) {
      let n;
      try {
        n = fs.readSync(fd, buf, 0, buf.length, null);
      } catch (err) {
        if (err && err.code === 'EAGAIN') continue;
        if (err && err.code === 'EOF') break;
        return null;
      }
      if (n === 0) break;
      total += n;
      if (total > STDIN_MAX_BYTES) return null;
      chunks.push(Buffer.from(buf.subarray(0, n)));
    }
    return Buffer.concat(chunks).toString('utf8');
  } catch {
    return null;
  }
}
