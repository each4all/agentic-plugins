#!/usr/bin/env node
// plugins/attention/adapters/claude/hooks/stop.mjs
//
// ADR-0040 §3 Claude `Stop` sensor. Stop has no matcher and fires on every
// turn end for every plugin, with no cross-plugin ordering guarantee — this
// sensor therefore never assumes a persona Stop hook (engineer/orchestrator
// archive or sidecar backstop) ran first.
//
// Kind/subject mapping per the §1 contract:
//   Stop with a FRESH terminal workflow projection → workflow-terminal,
//     subject = workflow_id. Freshness is the §3 three-part gate implemented
//     in lib/sensor.mjs readFreshProjection: workflow-id consistency + mtime
//     bound + the per-persona `.footer-rendered` marker (engineer and
//     orchestrator marker shapes DIFFER; founder writes no sidecar at v1 and
//     stays bare-Stop-only).
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
  readFreshProjection,
  readStdinJson,
  resolveHostname,
  resolveRepoRoot,
  resolveTopic,
  turnCompleteSubject,
  workflowTerminalSubject,
} from '../../../scripts/lib/sensor.mjs';

async function main() {
  const payload = await readStdinJson();
  const cwd = typeof payload.cwd === 'string' && payload.cwd.length > 0 ? payload.cwd : process.cwd();
  const repoRoot = resolveRepoRoot(cwd);
  if (!repoRoot) return;
  const repoLabel = path.basename(repoRoot);
  const repoIdent = deriveRepoIdent(repoRoot);
  const now = Date.now();
  // ADR-0041 §4 cross-machine routing/display fields, resolved once and shared
  // by every event this turn (workflow-terminal set + the bare fallback). The
  // session hint is best-effort: session_id primary, prompt_id fallback.
  const sessionId = payload.session_id;
  const promptId = payload.prompt_id;
  const hostname = resolveHostname();
  const topic = resolveTopic({ repoRoot, repoLabel });
  const sessionHint = buildSessionHint({ sessionId, promptId });

  // State enrichment — one workflow-terminal event per persona whose one-shot
  // projection passes every freshness gate. Both personas can be terminal in
  // one turn (e.g. a macro closes together with its last engineer child).
  const terminalEvents = [];
  for (const persona of SENSOR_PERSONAS) {
    const fresh = readFreshProjection({ repoRoot, persona, now });
    if (!fresh) continue;
    const { workflowId, projection } = fresh;
    const refs = { workflow_id: workflowId };
    if (typeof projection.workflow_path === 'string' && projection.workflow_path.length > 0) {
      refs.path = projection.workflow_path;
    }
    // ADR-0041 §3 — phase rides in refs (the egress payload reads workflow_id +
    // phase from refs when a fresh projection exists).
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
    // ADR-0041 §3a — born the opt-in closed-vocabulary headline from the STRUCTURED
    // projection signal (archive_gate) only. map-or-omit: an unknown/absent gate
    // yields null and buildEvent omits headline (never a guess). This
    // workflow-terminal path is the ONLY headline-bearing one — the bare
    // turn-complete below deliberately carries none (a kind-only token would
    // overstate a single turn as workflow status). Never derived from free text
    // (title/body/next_action); the runtime opt-in + enum-guard gate egress.
    const headline = deriveHeadlineToken({ kind: 'workflow-terminal', archiveGate: projection.archive_gate });
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
    for (const event of terminalEvents) {
      await emitEvent({ repoRoot, event });
    }
    return;
  }

  // Bare case — stale/missing projections degrade to a turn-complete
  // notification built from common fields only, never a wrong workflow claim.
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
}

try {
  await main();
} catch {
  // Fail-closed: a notification failure must never break the host lifecycle.
}
process.exit(0);
