#!/usr/bin/env node
// agentic-statusline.mjs — Claude Code statusLine shim for agentic-plugins
// (rendered by the runtime:bootstrap statusline plan, ADR-0048 §2/§2.1).
//
// @agentic-receiver: statusline delegating-shim v1
//
// Source template: plugins/runtime/receivers/agentic-statusline.mjs. It ships
// with the runtime plugin as render-input DATA, deliberately outside
// plugins/runtime/scripts/: the ADR-0035 §4 executor guard governs code the
// runtime itself executes, and runtime never imports or spawns this shim —
// the plan renders it into an artifact and the USER installs and runs it
// (canonical home: ~/.agentic-plugins/bin/agentic-statusline.mjs, invoked by
// Claude Code as `node "<path>"` per the settings statusLine fragment).
//
// THIS FILE IS A DELEGATING SHIM. Everything it once implemented inline — the
// per-item renderers and their sanitization — now lives in the plugin at
// scripts/receiver-api.mjs, and this shim resolves that API at RUN time. The
// reason is that installed bytes are frozen at install time: whatever logic
// ships in this file cannot be corrected by upgrading the plugin, so the
// volatile half belongs on the other side of the resolution. What remains here
// is only what must bootstrap the resolution itself, which is why it cannot be
// delegated in turn.
//
// Delegation is by dynamic import(), NOT by spawning a child. Measured over 20
// runs on the same session document, all shapes producing byte-identical
// output: today's inline copy 46.0 ms, import() 47.1 ms, child process 75.8 ms
// (bare `node -e ''` floor 26.5 ms). The statusline renders synchronously on
// every prompt, so a second interpreter start would be charged to every render.
//
// Contract (ADR-0048 §2, the shim half of the sufficiency gate): read-only,
// bounded, credential-free, network-free, non-polling, order-preserving under
// missing data. Under §2 as amended that contract binds this shim AND the
// packaged API it delegates to. Claude Code writes one session JSON document
// on stdin and displays the first stdout line; triggers are host-driven (never
// a timer here). Fail-closed silent: exit 0 always, at most one plain line on
// stdout, nothing on stderr.
//
// Git branch (ADR-0048 realization decision, owner-approved 2026-07-23): an
// ordinary Claude session's stdin carries no branch, so the API runs ONE
// bounded read-only `git branch --show-current` — fixed argv, no shell, cwd
// validated from the session JSON, 1.5s timeout, capped output, scrubbed child
// environment. That stays inside the §2 shim contract (read-only + bounded;
// the contract forbids network/credentials/polling, not a read-only VCS
// query); the machine-bootstrap contract records the deviation.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const STATUSLINE_ITEMS = ['__AGENTIC_STATUSLINE_ITEMS__'];

// Rendered from the planning runtime's own version: the first runtime whose
// receiver-api.mjs this shim targets.
const MIN_RUNTIME_VERSION = '__AGENTIC_MIN_RUNTIME_VERSION__';
// Capability major, checked IN ADDITION to the version gate. A semver floor
// only proves which release answered; it cannot prove this build still exports
// the entry point at the signature this shim calls.
//
// Required EXACTLY, never `>=`: the major is incremented precisely because the
// old shape broke, so accepting a higher one would accept the very runtime that
// broke this shim. An incompatible runtime therefore reads as no runtime.
const REQUIRED_STATUSLINE_MAJOR = 1;

// The shim's own output envelope, kept here deliberately. The API is upgradable
// code; this file is the stable guarantee the host actually depends on — at
// most ONE plain line, no control or bidi bytes, bounded length. A future API
// bug must not be able to reach the terminal through a shim that simply relays
// whatever it was handed.
const LINE_MAX_CHARS = 512;

const STDIN_MAX_BYTES = 256 * 1024;

// Bounded stdin read. STREAMING cap: read-to-EOF-then-check would buffer an
// unbounded pipe before the bound applies, so read at most MAX+1 bytes and
// stop — an over-cap or erroring stream returns null immediately. This stays
// in the shim because it must happen before any resolution work: the host is
// already writing, and a shim that resolved first could block on a full pipe.
function readStdinBounded() {
  try {
    const chunks = [];
    let total = 0;
    const buf = Buffer.alloc(65536);
    for (;;) {
      let n;
      try {
        n = fs.readSync(0, buf, 0, buf.length, null);
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

// Prerelease-strict floor gate: a prerelease of the floor version is BELOW it.
// Build metadata (`1.2.3+build`) is stripped first — it never affects
// precedence, and splitting on '-' without the strip would misread
// `1.2.3+build-5` as a prerelease and reject a valid runtime.
function versionGte(version, min) {
  const [core, prerelease] = String(version).split('+', 1)[0].split('-', 2);
  const parts = core.split('.').map(function (x) { return Number.parseInt(x, 10) || 0; });
  const floor = String(min).split('+', 1)[0].split('-', 1)[0].split('.').map(function (x) { return Number.parseInt(x, 10) || 0; });
  for (let i = 0; i < 3; i += 1) {
    const av = parts[i] || 0;
    const bv = floor[i] || 0;
    if (av !== bv) return av > bv;
  }
  return !prerelease;
}

function readManifestVersion(root) {
  const layouts = [
    path.join(root, '.claude-plugin', 'plugin.json'),
    path.join(root, '.codex-plugin', 'plugin.json'),
  ];
  for (const manifestPath of layouts) {
    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      if (typeof manifest.version === 'string' && manifest.version.trim()) {
        return manifest.version.trim();
      }
    } catch {}
  }
  return null;
}

function semverCompare(a, b) {
  const na = String(a).split('+', 1)[0];
  const nb = String(b).split('+', 1)[0];
  const pa = na.split('-', 1)[0].split('.').map(function (x) { return Number.parseInt(x, 10) || 0; });
  const pb = nb.split('-', 1)[0].split('.').map(function (x) { return Number.parseInt(x, 10) || 0; });
  for (let i = 0; i < 3; i += 1) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  }
  // Equal core: a clean release ranks ABOVE any prerelease of it, so the
  // candidate sort cannot pick a beta by directory order when the released
  // version is also installed.
  const preA = na.indexOf('-') === -1 ? 0 : 1;
  const preB = nb.indexOf('-') === -1 ? 0 : 1;
  return preB - preA;
}

// ADR-0039 §5 discovery ladder. The sibling-monorepo rung does not apply to a
// home-installed shim; point AGENTIC_RUNTIME_ROOT at a source checkout instead.
//
// Same-host preference: this is a CLAUDE statusline receiver, so the Claude
// cache is probed FIRST — a stale opposite-host Codex install must never
// shadow a current Claude one.
//
// The ladder resolves the AUTHORITATIVE root — the newest install that is a
// runtime plugin at all — and stops. It deliberately does NOT filter candidates
// by whether they carry the receiver API: doing so would let a newer runtime
// that dropped the API be passed over in favour of an older one that still has
// it, silently resurrecting an implementation the newer release removed. One
// root is chosen, then gated; a root that fails the gate fails closed rather
// than handing off to a staler candidate.
function isRuntimePlugin(root) {
  return readManifestVersion(root) !== null;
}

function resolveRuntimeRoot() {
  const override = process.env.AGENTIC_RUNTIME_ROOT;
  if (typeof override === 'string' && override.length > 0) {
    if (!path.isAbsolute(override)) return null;
    return isRuntimePlugin(override) ? override : null;
  }
  const home = os.homedir();
  const claudeBase = path.join(home, '.claude', 'plugins', 'cache', 'agentic-plugins', 'runtime');
  let candidates = [];
  try {
    for (const entry of fs.readdirSync(claudeBase, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const root = path.join(claudeBase, entry.name);
      const version = readManifestVersion(root);
      if (!version) continue;
      candidates.push({ version: version, root: root });
    }
  } catch {
    candidates = [];
  }
  if (candidates.length > 0) {
    candidates.sort(function (a, b) { return semverCompare(b.version, a.version); });
    return candidates[0].root;
  }
  const codexHome = typeof process.env.CODEX_HOME === 'string' && process.env.CODEX_HOME.length > 0
    ? path.resolve(process.env.CODEX_HOME)
    : path.join(home, '.codex');
  const codexBase = path.join(codexHome, '.tmp', 'marketplaces', 'agentic-plugins', 'plugins', 'runtime');
  try {
    if (isRuntimePlugin(codexBase)) return codexBase;
  } catch {}
  return null;
}

// The stable output envelope — see LINE_MAX_CHARS. Returns null when the value
// cannot be rendered as one safe line.
function safeLine(value) {
  if (typeof value !== 'string' || value.length === 0) return null;
  const text = value
    .replace(/\u001b\[[0-9;]*[A-Za-z]/g, '')
    .replace(/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (text.length === 0) return null;
  return text.length > LINE_MAX_CHARS ? text.slice(0, LINE_MAX_CHARS) : text;
}

async function main() {
  // Read the host document FIRST — see readStdinBounded.
  const text = readStdinBounded();
  if (text === null) return;
  let session;
  try {
    session = JSON.parse(text);
  } catch {
    return;
  }
  const root = resolveRuntimeRoot();
  if (root === null) return;                    // no runtime — print nothing
  const version = readManifestVersion(root);
  if (!version || !versionGte(version, MIN_RUNTIME_VERSION)) return;  // downgraded
  let api;
  try {
    // pathToFileURL, not a hand-built `file:` string: a manual construction
    // mishandles '#', '?' and '%' in a path, which are legal on both platforms.
    api = await import(pathToFileURL(path.resolve(root, 'scripts', 'receiver-api.mjs')).href);
  } catch {
    return;
  }
  // Capability gate — a resolved runtime that passes the version gate but does
  // not export what this shim calls is treated exactly like no runtime.
  if (typeof api.renderStatusline !== 'function') return;
  if (api.RECEIVER_API_MAJORS?.statusline !== REQUIRED_STATUSLINE_MAJOR) return;
  let line = null;
  try {
    line = api.renderStatusline({ session: session, items: STATUSLINE_ITEMS });
  } catch {
    return;
  }
  const safe = safeLine(line);
  if (safe !== null) {
    try { process.stdout.write(safe + '\n'); } catch { /* EPIPE — host cancelled */ }
  }
}

try {
  await main();
} catch {
  // Fail-closed silent: a statusline must never break the prompt.
}
process.exit(0);
