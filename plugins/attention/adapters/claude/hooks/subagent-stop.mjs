#!/usr/bin/env node
// plugins/attention/adapters/claude/hooks/subagent-stop.mjs
//
// ADR-0040 §3 Claude `SubagentStop` sensor. Registered without an
// `agent_type` matcher at v1 (the matcher stays available for tuning).
//
// Kind/subject mapping per the §1 contract:
//   SubagentStop → subagent-complete, subject = agent_id (the documented
//   agent-scoped input field), fixed status token (the sensor observes
//   exactly one status moment — the subagent stopped).
//
// Fail-closed observer (ADR-0040 §7): exit 0 always, nothing on stdout ever,
// no decision output; a payload without agent_id ⇒ silent no-op.

import path from 'node:path';

import {
  SUBAGENT_COMPLETE_STATUS,
  buildEvent,
  deriveRepoIdent,
  emitEvent,
  readStdinJson,
  resolveRepoRoot,
  subagentCompleteSubject,
} from '../../../scripts/lib/sensor.mjs';

async function main() {
  const payload = await readStdinJson();
  const cwd = typeof payload.cwd === 'string' && payload.cwd.length > 0 ? payload.cwd : process.cwd();
  const repoRoot = resolveRepoRoot(cwd);
  if (!repoRoot) return;
  const agentId = payload.agent_id;
  if (typeof agentId !== 'string' || agentId.length === 0) return;
  const agentType = typeof payload.agent_type === 'string' ? payload.agent_type : '';
  const repoLabel = path.basename(repoRoot);

  await emitEvent({
    repoRoot,
    event: buildEvent({
      repoIdent: deriveRepoIdent(repoRoot),
      kind: 'subagent-complete',
      subject: subagentCompleteSubject({ agentId }),
      status: SUBAGENT_COMPLETE_STATUS,
      title: `Subagent complete — ${repoLabel}`,
      body: agentType.length > 0 ? `agent ${agentId} (${agentType})` : `agent ${agentId}`,
      urgency: 'normal',
    }),
  });
}

try {
  await main();
} catch {
  // Fail-closed: a notification failure must never break the host lifecycle.
}
process.exit(0);
