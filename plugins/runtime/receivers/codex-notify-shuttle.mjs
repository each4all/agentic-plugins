#!/usr/bin/env node
// codex-notify-shuttle.mjs — Codex notify= receiver for agentic-plugins
// (rendered by `runtime:settings --notification-plan`, ADR-0040 §4).
//
// Source template: plugins/runtime/receivers/codex-notify-shuttle.mjs. It
// ships with the runtime plugin as render-input DATA, deliberately outside
// plugins/runtime/scripts/: the ADR-0035 §4 executor guard governs code the
// runtime itself executes, and runtime never imports or spawns this receiver
// — the plan renders it into an artifact and the USER installs and runs it.
//
// Codex invokes this script with the notification payload appended as the
// LAST argv argument: kebab-case JSON whose only variant at the pinned Codex
// version is {"type":"agent-turn-complete","turn-id":...,"input-messages":
// [...],"last-assistant-message":<string|null>} plus an undocumented "client"
// field that is tolerated (unknown fields are ignored, never an error).
//
// This shuttle exists so ~/.codex/config.toml never points into a
// version-pinned plugin cache path: it re-resolves the CURRENT runtime plugin
// root on every invocation (env override -> Codex fixed cache -> Claude cache
// SemVer-max), version-gates it, and delegates to notify.mjs emit. Requires
// Node on PATH (invoked via /usr/bin/env node).
//
// Fail-closed silent: exit 0 always, nothing on stdout, at most one stderr
// diagnostic line. A notification failure must never break the Codex turn.

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// First runtime version whose notify.mjs emit interface this shuttle targets
// (rendered from the planning runtime's own version).
const MIN_RUNTIME_VERSION = '__AGENTIC_MIN_RUNTIME_VERSION__';

function diagnostic(reason) {
  try { process.stderr.write('codex-notify-shuttle: ' + reason + '\n'); } catch {}
}

// Walk up from cwd to the nearest .git marker (dir or worktree file).
function resolveRepoRoot(cwd) {
  let current = path.resolve(cwd);
  try { current = fs.realpathSync(current); } catch { return null; }
  for (;;) {
    if (fs.existsSync(path.join(current, '.git'))) return current;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

// Copy of the runtime notify-schema deriveRepoIdent contract (ADR-0040 §1):
// sanitized basename + 16-hex sha256 of the realpath, colon-free.
function deriveRepoIdent(repoRoot) {
  const resolved = path.resolve(repoRoot);
  let real = resolved;
  try { real = fs.realpathSync(resolved); } catch {}
  const base = path.basename(real).replace(/[^A-Za-z0-9._-]/g, '-') || 'repo';
  return base + '-' + createHash('sha256').update(real).digest('hex').slice(0, 16);
}

// Prerelease-strict floor gate: a prerelease of the floor version is BELOW it.
function versionGte(version, min) {
  const [core, prerelease] = String(version).split('-', 2);
  const parts = core.split('.').map(function (x) { return Number.parseInt(x, 10) || 0; });
  const floor = String(min).split('-', 1)[0].split('.').map(function (x) { return Number.parseInt(x, 10) || 0; });
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
  const pa = String(a).split('-', 1)[0].split('.').map(function (x) { return Number.parseInt(x, 10) || 0; });
  const pb = String(b).split('-', 1)[0].split('.').map(function (x) { return Number.parseInt(x, 10) || 0; });
  for (let i = 0; i < 3; i += 1) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  }
  return 0;
}

// ADR-0039 §5 discovery ladder, gated on scripts/notify.mjs presence. The
// sibling-monorepo rung does not apply to a home-installed shuttle; point
// AGENTIC_RUNTIME_ROOT at a source checkout instead.
//
// Same-host preference (the discover-engineer Codex P2 precedent): this is a
// CODEX notify receiver, so the Codex cache is probed FIRST — a stale
// opposite-host Claude cache must never shadow a current Codex install. The
// Codex home honors $CODEX_HOME exactly like the planner's config read.
function resolveRuntimeRoot() {
  const override = process.env.AGENTIC_RUNTIME_ROOT;
  if (typeof override === 'string' && override.length > 0) {
    if (!path.isAbsolute(override)) return null;
    if (fs.existsSync(path.join(override, 'scripts', 'notify.mjs'))) return override;
    return null;
  }
  const home = os.homedir();
  const codexHome = typeof process.env.CODEX_HOME === 'string' && process.env.CODEX_HOME.length > 0
    ? path.resolve(process.env.CODEX_HOME)
    : path.join(home, '.codex');
  const codexBase = path.join(codexHome, '.tmp', 'marketplaces', 'agentic-plugins', 'plugins', 'runtime');
  try {
    if (fs.existsSync(path.join(codexBase, 'scripts', 'notify.mjs'))) return codexBase;
  } catch {}
  const claudeBase = path.join(home, '.claude', 'plugins', 'cache', 'agentic-plugins', 'runtime');
  let candidates = [];
  try {
    for (const entry of fs.readdirSync(claudeBase, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const root = path.join(claudeBase, entry.name);
      const version = readManifestVersion(root);
      if (!version) continue;
      if (!fs.existsSync(path.join(root, 'scripts', 'notify.mjs'))) continue;
      candidates.push({ version: version, root: root });
    }
  } catch {
    candidates = [];
  }
  if (candidates.length > 0) {
    candidates.sort(function (a, b) { return semverCompare(b.version, a.version); });
    return candidates[0].root;
  }
  return null;
}

function main() {
  // Payload = LAST argv argument (receiver input contract). argv[0]=node,
  // argv[1]=this script; anything beyond means Codex appended the payload.
  if (process.argv.length <= 2) return;
  const payloadText = process.argv[process.argv.length - 1];
  let payload;
  try {
    payload = JSON.parse(payloadText);
  } catch {
    diagnostic('payload is not valid JSON');
    return;
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return;
  // Only variant at the pinned Codex version; future variants no-op silently.
  if (payload.type !== 'agent-turn-complete') return;
  const turnId = typeof payload['turn-id'] === 'string' && payload['turn-id'].length > 0
    ? payload['turn-id']
    : null;
  // last-assistant-message is nullable by contract.
  const lastMessage = typeof payload['last-assistant-message'] === 'string'
    ? payload['last-assistant-message']
    : '';
  const repoRoot = resolveRepoRoot(process.cwd());
  if (!repoRoot) return; // outside a repository — no notify state home
  const runtimeRoot = resolveRuntimeRoot();
  if (!runtimeRoot) {
    diagnostic('no runtime plugin root resolved (install agentic-plugins runtime or set AGENTIC_RUNTIME_ROOT)');
    return;
  }
  const runtimeVersion = readManifestVersion(runtimeRoot);
  if (!runtimeVersion || !versionGte(runtimeVersion, MIN_RUNTIME_VERSION)) {
    diagnostic('resolved runtime is older than ' + MIN_RUNTIME_VERSION);
    return;
  }
  const subject = turnId !== null
    ? 'codex-turn:' + turnId
    : 'codex-turn:payload-' + createHash('sha256').update(payloadText).digest('hex').slice(0, 12);
  const event = {
    // <repo-ident>:<kind>:<subject>:<status> — 'fired' is the §1 default
    // status token for turn-complete (a kind without a natural terminal
    // status), matching buildEventId's default.
    event_id: deriveRepoIdent(repoRoot) + ':turn-complete:' + subject + ':fired',
    source: 'codex-notify',
    kind: 'turn-complete',
    urgency: 'normal',
    title: 'Codex turn complete',
    body: lastMessage,
    refs: { path: repoRoot },
  };
  const child = spawn(process.execPath, [
    path.join(runtimeRoot, 'scripts', 'notify.mjs'),
    'emit',
    '--repo-root', repoRoot,
  ], { stdio: ['pipe', 'ignore', 'ignore'], detached: true });
  child.on('error', function () {});
  try {
    child.stdin.on('error', function () {});
    child.stdin.end(JSON.stringify(event));
  } catch {}
  child.unref();
}

try {
  main();
} catch (error) {
  diagnostic(error && error.message ? error.message : 'internal failure');
}
process.exitCode = 0;
