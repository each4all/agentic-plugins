#!/usr/bin/env node
// plugins/attention/adapters/claude/hooks/session-start.mjs
//
// ADR-0045 §7 Claude `SessionStart` entry sensor — the ONE hook surface of
// the entry-brief rollout (registered with an explicit `matcher: "startup"`
// in adapters/claude/hooks/hooks.json; the probed matrix pins both design
// constraints: an omitted matcher would match every source including
// `compact` — colliding with the persona compact-hook lane — and the 600 s
// default hook timeout would delay session entry, so the registration
// carries an explicit small `timeout`).
//
// The sensor is a policy-free dispatcher: it resolves the repo root from the
// hook payload, shells the runtime entry-brief arbiter through the
// capability-specific stdout-capturing seam (lib/sensor.mjs spawnEntryBrief:
// own ENTRY_BRIEF floor, executor-existence probe, fixed argv `entry-brief
// --repo-root <resolved> --host claude --surface session-start-hook`,
// bounded timeout + buffer), and relays AT MOST the one line that survives
// the validation boundary. Every proposal/precedence/gate decision is
// arbiter-side (ADR-0045 §1); the user-scope-only `entry_brief` gate is
// evaluated inside the executor (§17 — the spawn with the gate off is the
// accepted cost shape, mirroring the ADR-0044 publisher).
//
// This file is the scoped ADR-0040 §2.2 sensor-output exception: stdout
// carries exactly one marker-paired brief line (or nothing) — stdout-into-
// context is the point of a SessionStart hook. It never emits a structured
// hook response (in particular never `{"continue": false}`, which would
// halt Claude entirely — probed matrix, failure-isolation row); the
// validation boundary structurally prevents relaying one, because a
// marker-paired line can never parse as a bare JSON document.
//
// Fail-closed observer otherwise (ADR-0040 §7): exit 0 always, stderr
// untouched, and any failure — malformed stdin, non-git cwd, missing/too-old
// runtime, absent executor, executor failure, malformed/oversized output —
// degrades to injecting nothing. A lost brief is acceptable; a blocked or
// polluted session entry is not.

import {
  readStdinJson,
  resolveRepoRoot,
  spawnEntryBrief,
} from '../../../scripts/lib/sensor.mjs';

async function main() {
  const payload = await readStdinJson();
  // PAYLOAD-carried cwd ONLY — no process-cwd fallback (Codex Plan-verify).
  // The SessionStart payload always carries `cwd` (probed matrix), so a
  // payload without one means malformed/empty hook input — and this sensor
  // INJECTS into model context, so malformed input must degrade to
  // injecting nothing, exactly as the capture spawn's payload-cwd rule
  // (stop.mjs) keys its write off real hook input. The Stop NOTIFICATION
  // path keeps its historical process-cwd fallback; this surface is
  // stricter by design.
  const payloadCwd = typeof payload.cwd === 'string' && payload.cwd.length > 0 ? payload.cwd : null;
  if (!payloadCwd) return;
  // Repo-scoped (contract §14: non-git cwd ⇒ silent no-op) — skip the spawn
  // entirely rather than paying it to learn the same answer.
  const repoRoot = resolveRepoRoot(payloadCwd);
  if (!repoRoot) return;
  const result = await spawnEntryBrief({ repoRoot });
  if (result.line) process.stdout.write(`${result.line}\n`);
}

try {
  await main();
} catch {
  // Fail-closed: an entry-sensor failure must never break session entry.
}
process.exit(0);
