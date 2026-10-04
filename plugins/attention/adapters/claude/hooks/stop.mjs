#!/usr/bin/env node
// plugins/attention/adapters/claude/hooks/stop.mjs
//
// ADR-0044 §2 Claude `Stop` sensor: the turn-end firing point of session
// capture. It feeds ONE allowlisted runtime-owned executor, the
// session-capture publisher (`context.mjs publish-session`). Stop has no
// matcher and fires on every turn end for every plugin, with no cross-plugin
// ordering guarantee — this sensor therefore never assumes a persona Stop hook
// (any onboarded persona's archive or sidecar backstop) ran first.
//
// Control flow:
//
//   1. Evidence collection: hook payload, repo root, and the freshness-checked
//      persona projection reads (lib/sensor.mjs readFreshProjection:
//      workflow-id consistency + strict workflow_kind + mtime bound + the
//      per-persona `.footer-rendered` marker with a fresh `at` render
//      timestamp, the transition anchor). All four onboarded personas are read
//      (ADR-0043 §3 — engineer / orchestrator / founder / designer).
//   2. Capture spawn: publish-session with fixed argv (--repo-root from the
//      payload cwd resolution, --host claude, clamped optional --session-id,
//      --workflow-evidence fresh only when step 1 observed a fresh terminal
//      projection). Gated by the publisher floor; the session_capture config
//      gate itself is evaluated publisher-side (ADR-0044 §3).
//
// ADR-0064 removed this hook's notification stage (workflow-terminal,
// turn-complete and response-needed events through `notify.mjs emit`).
//
// Fail-closed observer (ADR-0040 §7): exit 0 always, nothing on stdout ever,
// no Stop `decision` output (pure observation, never blocks stopping).

import {
  SENSOR_PERSONAS,
  readFreshProjection,
  readStdinJson,
  resolveRepoRoot,
  spawnPublishSession,
} from '../../../scripts/lib/sensor.mjs';

async function main() {
  const payload = await readStdinJson();
  // PAYLOAD-carried cwd ONLY (Codex review MAJOR): readStdinJson degrades
  // malformed/empty stdin to {}, and an automatic WRITE keyed off the process
  // cwd would let invalid hook input inside a repo replace a valid session
  // generation with an anonymous structural slot.
  const payloadCwd = typeof payload.cwd === 'string' && payload.cwd.length > 0 ? payload.cwd : null;
  if (!payloadCwd) return;
  // Repo-scoped v1 (contract §6): a non-git cwd produces nothing — the
  // publisher would no-op on the same probe.
  const repoRoot = resolveRepoRoot(payloadCwd);
  if (!repoRoot) return;
  const now = Date.now();
  let freshTerminal = false;
  for (const persona of SENSOR_PERSONAS) {
    if (readFreshProjection({ repoRoot, persona, now })) {
      freshTerminal = true;
      break;
    }
  }
  // The sensor relays observations only: the opt-in gate, fingerprint, lock,
  // and atomic publication are all publisher-side policy.
  await spawnPublishSession({
    repoRoot,
    sessionId: payload.session_id,
    // §5.3 evidence, not suppression: fresh when at least one persona's
    // terminal projection passed every freshness gate; omitted otherwise (the
    // publisher records `none`).
    workflowEvidence: freshTerminal ? 'fresh' : undefined,
  });
}

try {
  await main();
} catch {
  // Fail-closed: a sensor failure must never break the host lifecycle.
}
process.exit(0);
