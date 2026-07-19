#!/usr/bin/env node
// plugins/attention/adapters/claude/hooks/stop.mjs
//
// ADR-0040 §3 Claude `Stop` sensor, amended by ADR-0044 §2 into a
// host-lifecycle sensor feeding TWO allowlisted runtime-owned executors:
// the session-capture publisher (`context.mjs publish-session`) and the
// notification emitter (`notify.mjs emit`). Stop has no matcher and fires on
// every turn end for every plugin, with no cross-plugin ordering guarantee —
// this sensor therefore never assumes a persona Stop hook (any onboarded
// persona's archive or sidecar backstop) ran first.
//
// Control flow is three explicit stages (ADR-0044 §2 — deliberately NOT the
// pre-ADR-0044 single body with early returns, whose short-circuits would
// skip capture):
//
//   Stage 1 — shared evidence collection: hook payload, repo root, and the
//     freshness-checked persona projection reads BOTH later stages consume.
//     Only a missing repo root ends the turn here (v1 is repo-scoped for
//     capture per contract §6, and no notification can be built without a
//     repo identity either).
//   Stage 2 — capture spawn, in its OWN failure boundary: publish-session
//     with fixed argv (--repo-root from the payload cwd resolution, --host
//     claude, clamped optional --session-id, --workflow-evidence fresh only
//     when Stage 1 observed a fresh terminal projection). Gated by the
//     SEPARATE publisher floor (never the notify floor); the session_capture
//     config gate itself is evaluated publisher-side (ADR-0044 §3). Capture
//     failure must never skip or delay notification.
//   Stage 3 — notification construction + emission, in its own failure
//     boundary: the pre-ADR-0044 body. Its eligibility short-circuits
//     (missing session_id/prompt_id, no terminal event, notify errors) run
//     AFTER capture and can no longer skip it.
//
// Kind/subject mapping per the §1 contract:
//   Stop with a FRESH terminal workflow projection → workflow-terminal,
//     subject = workflow_id. Freshness is the §3 gate implemented in
//     lib/sensor.mjs readFreshProjection: workflow-id consistency + strict
//     workflow_kind + mtime bound + the per-persona `.footer-rendered`
//     marker with a fresh `at` render timestamp (the transition anchor).
//     All four onboarded personas enrich (ADR-0043 §3 — engineer /
//     orchestrator / founder / designer); orchestrator alone id-scopes the
//     marker filename, the other three use the slot-sibling shape documented
//     in each persona's session-handoff runbook.
//   Stop otherwise (the bare case) → turn-complete, subject =
//     session:<session_id>:<prompt_id> — both documented COMMON input fields
//     present on every hook event, so the bare case never relies on a
//     Stop-specific payload field.
//
// Fail-closed observer (ADR-0040 §7): exit 0 always, nothing on stdout ever,
// no Stop `decision` output (pure observation, never blocks stopping).

import path from 'node:path';

import {
  SENSOR_PERSONAS,
  WORKFLOW_TERMINAL_STATUS,
  buildEvent,
  buildSessionHint,
  deriveHeadlineToken,
  deriveRepoIdent,
  emitEvent,
  emitTerminalEvents,
  readFreshProjection,
  readStdinJson,
  resolveHostname,
  resolveRepoRoot,
  resolveTopic,
  spawnPublishSession,
  turnCompleteSubject,
  workflowTerminalSubject,
} from '../../../scripts/lib/sensor.mjs';

// Stage 2 — the ADR-0044 §2 capture spawn, isolated so neither a throw nor a
// slow publisher (bounded by its own one-slot timeout inside
// spawnPublishSession) can reach the notification stage. The sensor relays
// observations only: the opt-in gate, fingerprint, lock, and atomic
// publication are all publisher-side policy.
async function captureSession({ repoRoot, sessionId, freshProjections }) {
  try {
    await spawnPublishSession({
      repoRoot,
      sessionId,
      // §5.3 evidence, not suppression: fresh when the SAME projection read
      // that powers enrichment observed at least one fresh terminal
      // projection; omitted otherwise (the publisher records `none`).
      workflowEvidence: freshProjections.length > 0 ? 'fresh' : undefined,
    });
  } catch {
    // Capture failure must never skip notification (ADR-0044 §2).
  }
}

// Stage 3 — notification construction + emission (the pre-ADR-0044 body,
// operating on the Stage 1 shared evidence instead of re-reading it).
async function notifySession({ repoRoot, payload, sessionId, freshProjections }) {
  try {
    const repoLabel = path.basename(repoRoot);
    const repoIdent = deriveRepoIdent(repoRoot);
    // ADR-0041 §4 cross-machine routing/display fields, resolved once and
    // shared by every event this turn (workflow-terminal set + the bare
    // fallback). The session hint is best-effort: session_id primary,
    // prompt_id fallback.
    const promptId = payload.prompt_id;
    const hostname = resolveHostname();
    const topic = resolveTopic({ repoRoot, repoLabel });
    const sessionHint = buildSessionHint({ sessionId, promptId });

    // State enrichment — one workflow-terminal event per persona whose
    // one-shot projection passed every freshness gate in Stage 1. Multiple
    // personas can be terminal in one turn (e.g. a macro closes together
    // with its last engineer child).
    const terminalEvents = [];
    for (const { persona, workflowId, projection } of freshProjections) {
      const refs = { workflow_id: workflowId };
      if (typeof projection.workflow_path === 'string' && projection.workflow_path.length > 0) {
        refs.path = projection.workflow_path;
      }
      // ADR-0041 §3 — phase rides in refs (the egress payload reads
      // workflow_id + phase from refs when a fresh projection exists).
      if (typeof projection.phase === 'string' && projection.phase.length > 0) {
        refs.phase = projection.phase;
      }
      const bodyParts = [workflowId];
      if (typeof projection.phase === 'string' && projection.phase.length > 0) {
        bodyParts.push(`phase ${projection.phase}`);
      }
      if (typeof projection.next_action === 'string' && projection.next_action.length > 0) {
        bodyParts.push(`next: ${projection.next_action}`);
      }
      // ADR-0041 §3a — born the opt-in closed-vocabulary headline from the
      // STRUCTURED projection signal (archive_gate) only. map-or-omit: an
      // unknown/absent gate yields null and buildEvent omits headline (never
      // a guess). This workflow-terminal path is the ONLY headline-bearing
      // one — the bare turn-complete below deliberately carries none (a
      // kind-only token would overstate a single turn as workflow status).
      // Never derived from free text (title/body/next_action); the runtime
      // opt-in + enum-guard gate egress. persona threads through so the
      // manually-published personas' 'blocked' (usually publish-needed,
      // indistinguishable in the frozen projection) omits the token rather
      // than overclaiming (sensor.mjs map-or-omit).
      const headline = deriveHeadlineToken({ kind: 'workflow-terminal', archiveGate: projection.archive_gate, persona });
      terminalEvents.push(buildEvent({
        repoIdent,
        kind: 'workflow-terminal',
        subject: workflowTerminalSubject({ workflowId }),
        status: WORKFLOW_TERMINAL_STATUS,
        title: `${persona} workflow terminal — ${repoLabel}`,
        body: bodyParts.join(' · '),
        urgency: 'normal',
        refs,
        hostname,
        topic,
        sessionHint,
        headline,
      }));
    }
    if (terminalEvents.length > 0) {
      // Bounded TOTAL emission deadline (ADR-0043 §3 Plan-verify + Codex
      // review findings): each emission gets the FULL slot or is dropped — a
      // partial slot would kill an in-flight egress dispatch before its own
      // 8s network deadline. See emitTerminalEvents (sensor.mjs) for the
      // contract; the slot/deadline values are the ADR-0044 §2 Stop hot-path
      // budget contract constants.
      await emitTerminalEvents({ repoRoot, events: terminalEvents });
      return;
    }

    // Bare case — stale/missing projections degrade to a turn-complete
    // notification built from common fields only, never a wrong workflow
    // claim. These short-circuits are notification-eligibility only: capture
    // already ran in Stage 2.
    if (typeof sessionId !== 'string' || sessionId.length === 0) return;
    if (typeof promptId !== 'string' || promptId.length === 0) return;
    await emitEvent({
      repoRoot,
      event: buildEvent({
        repoIdent,
        kind: 'turn-complete',
        subject: turnCompleteSubject({ sessionId, promptId }),
        title: `Turn complete — ${repoLabel}`,
        body: `session ${sessionId} · prompt ${promptId}`,
        urgency: 'normal',
        hostname,
        topic,
        sessionHint,
      }),
    });
  } catch {
    // Notification failure is equally isolated — capture already completed.
  }
}

async function main() {
  // Stage 1 — shared evidence collection, consumed by BOTH stages below.
  const payload = await readStdinJson();
  const payloadCwd = typeof payload.cwd === 'string' && payload.cwd.length > 0 ? payload.cwd : null;
  const cwd = payloadCwd ?? process.cwd();
  const repoRoot = resolveRepoRoot(cwd);
  // Repo-scoped v1 (contract §6): a non-git cwd produces nothing — the
  // publisher would no-op on the same probe, and no notification can be
  // built without a repo identity.
  if (!repoRoot) return;
  const sessionId = payload.session_id;
  const now = Date.now();
  const freshProjections = [];
  for (const persona of SENSOR_PERSONAS) {
    const fresh = readFreshProjection({ repoRoot, persona, now });
    if (fresh) freshProjections.push({ persona, ...fresh });
  }

  // Stage 2 before Stage 3 (ADR-0044 §2): notification eligibility
  // short-circuits must not skip or abort the capture spawn, and capture
  // failure must not skip notification. Capture additionally requires a
  // PAYLOAD-carried cwd (Codex review MAJOR): readStdinJson degrades
  // malformed/empty stdin to {}, and the process-cwd FALLBACK above exists
  // only to serve the pre-ADR-0044 notification path — an automatic WRITE
  // keyed off that fallback would let invalid hook input inside a repo
  // replace a valid session generation with an anonymous structural slot.
  if (payloadCwd) {
    await captureSession({ repoRoot, sessionId, freshProjections });
  }
  await notifySession({ repoRoot, payload, sessionId, freshProjections });
}

try {
  await main();
} catch {
  // Fail-closed: a sensor failure must never break the host lifecycle.
}
process.exit(0);
