#!/usr/bin/env node
// plugins/attention/adapters/claude/hooks/notification.mjs
//
// ADR-0040 §3 Claude `Notification` sensor. The manifest-declared
// adapters/claude/hooks/hooks.json registration (kept out of Codex's
// default-discovery path per the §3 amendment) carries this entry with
// `notification_type` matchers (permission_prompt, idle_prompt);
// the sensor still branches on the payload's own notification_type — a
// self-contained observer never trusts registration-time filtering alone —
// and silently ignores every other type (auth_success, elicitation variants).
//
// Kind/subject mapping per the §1 contract (not sensor discretion):
//   permission_prompt → approval, subject session:<session_id>:<content-hash>,
//                       urgency urgent (approval attention is the core goal);
//   idle_prompt       → idle, subject session:<session_id>, urgency normal.
//
// Fail-closed observer (ADR-0040 §7): exit 0 always, nothing on stdout ever,
// no decision output; missing payload fields / repo / runtime ⇒ silent no-op.

import path from 'node:path';

import {
  approvalSubject,
  buildEvent,
  buildSessionHint,
  deriveHeadlineToken,
  deriveRepoIdent,
  emitEvent,
  idleSubject,
  readStdinJson,
  resolveHostname,
  resolveRepoRoot,
  resolveTopic,
} from '../../../scripts/lib/sensor.mjs';

async function main() {
  const payload = await readStdinJson();
  const cwd = typeof payload.cwd === 'string' && payload.cwd.length > 0 ? payload.cwd : process.cwd();
  const repoRoot = resolveRepoRoot(cwd);
  if (!repoRoot) return;
  const sessionId = payload.session_id;
  if (typeof sessionId !== 'string' || sessionId.length === 0) return;

  const notificationType = payload.notification_type;
  // Only permission_prompt / idle_prompt map to events. Bail BEFORE any
  // routing-field fs work (resolveTopic reads .git) for the ignored types
  // (auth_success, elicitation variants) — cheaper, and keeps the .git read off
  // the path for notifications this sensor never emits.
  if (notificationType !== 'permission_prompt' && notificationType !== 'idle_prompt') return;
  const message = typeof payload.message === 'string' ? payload.message : '';
  const repoLabel = path.basename(repoRoot);
  const repoIdent = deriveRepoIdent(repoRoot);
  // ADR-0041 §4 cross-machine routing/display fields (shared across the event).
  const hostname = resolveHostname();
  const topic = resolveTopic({ repoRoot, repoLabel });
  const sessionHint = buildSessionHint({ sessionId });

  let event = null;
  if (notificationType === 'permission_prompt') {
    event = buildEvent({
      repoIdent,
      kind: 'approval',
      subject: approvalSubject({ sessionId, message }),
      title: `Approval needed — ${repoLabel}`,
      body: message,
      urgency: 'urgent',
      hostname,
      topic,
      sessionHint,
      // ADR-0047 §4 (narrow ADR-0041 §3a amendment) — the host's
      // notification_type matcher IS the structural signal, so the
      // needs-approval map is total for this path (map-or-omit preserved:
      // no inference happens here). The idle_prompt path below stays
      // headline-free. Headlines remain egress-display fields behind the
      // §3a default-OFF opt-in; local channels are unaffected.
      headline: deriveHeadlineToken({ kind: 'approval' }),
    });
  } else if (notificationType === 'idle_prompt') {
    event = buildEvent({
      repoIdent,
      kind: 'idle',
      subject: idleSubject({ sessionId }),
      title: `Idle — ${repoLabel}`,
      body: message.length > 0 ? message : 'Session is waiting for input',
      urgency: 'normal',
      hostname,
      topic,
      sessionHint,
    });
  }
  if (event) {
    await emitEvent({ repoRoot, event });
  }
}

try {
  await main();
} catch {
  // Fail-closed: a notification failure must never break the host lifecycle.
}
process.exit(0);
