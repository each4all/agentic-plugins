#!/usr/bin/env node
// codex-notify-shuttle.mjs — Codex notify= receiver for agentic-plugins
// (rendered by `runtime:settings --notification-plan`, ADR-0040 §4).
//
// @agentic-receiver: codex-notify delegating-shim v1
//
// Source template: plugins/runtime/receivers/codex-notify-shuttle.mjs. It
// ships with the runtime plugin as render-input DATA, deliberately outside
// plugins/runtime/scripts/: the ADR-0035 §4 executor guard governs code the
// runtime itself executes, and runtime never imports or spawns this receiver
// — the plan renders it into an artifact and the USER installs and runs it.
//
// Codex invokes this script with the notification payload appended as the
// LAST argv argument.
//
// THIS FILE IS A DELEGATING SHIM. It used to map the payload to a notify event
// itself — deriving the repo ident and choosing the event kind. Those are the
// parts that go stale: an installed file is frozen at install time, and the
// ADR-0047 §5 change (agent-turn-complete -> response-needed) is recorded in
// this file's own history as having left older installed shuttles emitting a
// superseded kind. The mapping now lives in the plugin
// (scripts/receiver-api.mjs, reached through `notify.mjs receive`), so this
// shim hands over the RAW payload and the mapping upgrades with the plugin.
//
// The ACCEPTED-VARIANT GATE deliberately does NOT move. ADR-0047 §5 makes the
// unknown-type return a contract in the strong form: a non-agent-turn-complete
// payload must leave notify.mjs NEVER INVOKED, not merely emit nothing —
// because wiring a newly observed variant requires a source-verified payload
// and its own follow-up decision. Delegating that check would satisfy "no
// event" while breaking "no invocation". It is also not the thing that went
// stale: the §5 incident changed the KIND an accepted variant maps to, which
// is precisely what now lives in the plugin.
//
// What remains here is only what must bootstrap the delegation: re-resolve the
// CURRENT runtime plugin root on every invocation (env override -> Claude
// cache SemVer-max -> Codex fixed cache), version-gate it, and spawn. That
// ladder cannot itself be delegated — the shim has to find the runtime before
// it can call it — so it is the irreducible copy, and it is also the stable
// one: it changes only when install layouts change, not when a mapping does.
//
// Delegation is by DETACHED SPAWN, unlike the statusline shim's in-process
// import. A notification is fire-and-forget and must not hold the Codex turn,
// so an extra interpreter start costs nothing here; the statusline renders
// synchronously on every prompt, where the same shape measured +29.8 ms.
// Requires Node on PATH (invoked via /usr/bin/env node).
//
// Fail-closed silent: exit 0 always, nothing on stdout, at most one stderr
// diagnostic line. A notification failure must never break the Codex turn.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// First runtime version whose receiver-api.mjs / `notify.mjs receive`
// interface this shuttle targets (rendered from the planning runtime's own
// version).
const MIN_RUNTIME_VERSION = '__AGENTIC_MIN_RUNTIME_VERSION__';

function diagnostic(reason) {
  try { process.stderr.write('codex-notify-shuttle: ' + reason + '\n'); } catch {}
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

// Walk up from cwd to the nearest .git marker (dir or worktree file). Kept
// local so a directory with no notify state home costs no spawn at all.
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

function main() {
  // Payload = LAST argv argument (receiver input contract). argv[0]=node,
  // argv[1]=this script; anything beyond means Codex appended the payload.
  if (process.argv.length <= 2) return;
  const payloadText = process.argv[process.argv.length - 1];
  // ADR-0047 §5 accepted-variant gate — see the header. Parsed here ONLY to
  // decide whether to invoke at all; the payload is forwarded verbatim and
  // every field of it is interpreted on the other side.
  let payload;
  try {
    payload = JSON.parse(payloadText);
  } catch {
    diagnostic('payload is not valid JSON');
    return;
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return;
  if (payload.type !== 'agent-turn-complete') return;
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
  // Everything past the gate is the runtime's to decide: the repo ident, the
  // event kind, the id shape, the title. Those are what the plugin upgrade
  // must be able to change.
  const child = spawn(process.execPath, [
    path.join(runtimeRoot, 'scripts', 'notify.mjs'),
    'receive',
    '--source', 'codex-notify',
    '--cwd', repoRoot,
  ], { stdio: ['pipe', 'ignore', 'ignore'], detached: true });
  child.on('error', function () {});
  try {
    child.stdin.on('error', function () {});
    child.stdin.end(payloadText);
  } catch {}
  child.unref();
}

try {
  main();
} catch (error) {
  diagnostic(error && error.message ? error.message : 'internal failure');
}
process.exitCode = 0;
