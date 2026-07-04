#!/usr/bin/env node
// plugins/attention/adapters/claude/hooks/notification.mjs
//
// ADR-0040 §3 Claude `Notification` sensor. hooks/hooks.json registers this
// entry with `notification_type` matchers (permission_prompt, idle_prompt);
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
  deriveRepoIdent,
  emitEvent,
  idleSubject,
  readStdinJson,
  resolveRepoRoot,
} from '../../../scripts/lib/sensor.mjs';

async function main() {
  const payload = await readStdinJson();
  const cwd = typeof payload.cwd === 'string' && payload.cwd.length > 0 ? payload.cwd : process.cwd();
  const repoRoot = resolveRepoRoot(cwd);
  if (!repoRoot) return;
  const sessionId = payload.session_id;
  if (typeof sessionId !== 'string' || sessionId.length === 0) return;

  const notificationType = payload.notification_type;
  const message = typeof payload.message === 'string' ? payload.message : '';
  const repoLabel = path.basename(repoRoot);
  const repoIdent = deriveRepoIdent(repoRoot);

  let event = null;
  if (notificationType === 'permission_prompt') {
    event = buildEvent({
      repoIdent,
      kind: 'approval',
      subject: approvalSubject({ sessionId, message }),
      title: `Approval needed — ${repoLabel}`,
      body: message,
      urgency: 'urgent',
    });
  } else if (notificationType === 'idle_prompt') {
    event = buildEvent({
      repoIdent,
      kind: 'idle',
      subject: idleSubject({ sessionId }),
      title: `Idle — ${repoLabel}`,
      body: message.length > 0 ? message : 'Session is waiting for input',
      urgency: 'normal',
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
