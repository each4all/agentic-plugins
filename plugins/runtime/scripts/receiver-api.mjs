#!/usr/bin/env node
// receiver-api.mjs — the stable packaged API that agentic-plugins' installed
// receivers delegate to (ADR-0048 §2 as amended, ADR-0040 §4).
//
// WHY THIS EXISTS. The two receivers under plugins/runtime/receivers/ are
// TEMPLATES: the plan renders them into ~/.agentic-plugins/bin/ and the USER
// installs and runs them. Whatever logic those rendered files carry is frozen
// at install time and cannot be updated by upgrading the plugin — the exact
// hazard recorded in the shuttle's own header, where an ADR-0047 §5 mapping
// change left older installed shuttles emitting a superseded event kind.
//
// So the volatile behaviour lives HERE, in the plugin, and the installed files
// keep only what must bootstrap: find the runtime, gate it, delegate.
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
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

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
// The two receivers are versioned SEPARATELY so a change to one does not force
// the other's installed copies to be re-rendered.
export const RECEIVER_API_MAJORS = Object.freeze({
  statusline: 1,
  codexNotify: 1,
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

/**
 * Map a raw Codex `notify=` payload to a runtime notify event.
 *
 * The shuttle used to build this event itself, which is what froze the
 * superseded `turn-complete` kind into installed copies. Handing the RAW
 * payload here means the mapping upgrades with the plugin.
 *
 * Returns { repoRoot, event } or null when there is nothing to emit (not in a
 * repository, unparseable payload, or a payload variant this build does not
 * map). Never throws.
 */
export async function mapCodexNotifyPayload({ payloadText, cwd = process.cwd() } = {}) {
  if (typeof payloadText !== 'string' || payloadText.length === 0) return null;
  let payload;
  try { payload = JSON.parse(payloadText); } catch { return null; }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  // Only variant at the pinned Codex version; future variants no-op silently.
  if (payload.type !== 'agent-turn-complete') return null;
  const repoRoot = resolveRepoRoot(cwd);
  if (!repoRoot) return null; // outside a repository — no notify state home
  const turnId = typeof payload['turn-id'] === 'string' && payload['turn-id'].length > 0
    ? payload['turn-id']
    : null;
  const lastMessage = typeof payload['last-assistant-message'] === 'string'
    ? payload['last-assistant-message']
    : '';
  // The repo-ident contract has exactly ONE implementation
  // (lib/notify-schema.mjs, ADR-0040 §1). It is imported LAZILY rather than at
  // module top so the statusline path — which never maps a payload — does not
  // pay for the notify graph on every prompt render. Re-implementing it here to
  // stay leaf-light would only move the duplicate from installed bytes into
  // packaged bytes, which is the problem this module exists to remove.
  const { deriveRepoIdent } = await import('./lib/notify-schema.mjs');
  const subject = turnId !== null
    ? 'codex-turn:' + turnId
    : 'codex-turn:payload-' + createHash('sha256').update(payloadText).digest('hex').slice(0, 12);
  return {
    repoRoot,
    event: {
      // <repo-ident>:<kind>:<subject>:<status> — 'fired' is the §1 default
      // status token for response-needed (a kind without a natural terminal
      // status), matching buildEventId's default.
      //
      // ADR-0047 §5: agent-turn-complete maps to response-needed as an
      // ACCEPTED APPROXIMATION (a completed Codex turn with nobody watching is
      // at worst an early your-turn, never a lost one) — kind only; the
      // codex-turn subject namespace, fired status, codex-notify source, and
      // the no-headline posture are preserved.
      event_id: deriveRepoIdent(repoRoot) + ':response-needed:' + subject + ':fired',
      source: 'codex-notify',
      kind: 'response-needed',
      urgency: 'normal',
      title: 'Codex turn complete',
      body: lastMessage,
      refs: { path: repoRoot },
    },
  };
}

// Walk up from cwd to the nearest .git marker (dir or worktree file).
function resolveRepoRoot(cwd) {
  let current;
  try { current = fs.realpathSync(path.resolve(cwd)); } catch { return null; }
  for (;;) {
    if (fs.existsSync(path.join(current, '.git'))) return current;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}



/** Bounded stdin read, shared by the receivers that consume a host JSON document. */
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
