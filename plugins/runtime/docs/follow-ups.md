# Runtime Follow-ups

ADR-0024 defines more than the first `doctor` PR. This file keeps the deferred surfaces explicit so `runtime:doctor` does not grow into settings or workflow mutation by accident.

## Deferred to follow-up PRs

- `runtime:settings`: dry-run by default, explicit apply for any mutation, no auth automation, no secret writes, and no silent sandbox/permission relaxation.
- Dynamic peer consensus: budget-driven fanout, disagreement extraction, targeted rebuttal/verification, synthesis, and bounded iteration. Raw peer outputs stay in artifacts; the main session receives synthesized results and evidence pointers.
- Context hygiene: main-session context budget checks and artifact-pointer summaries. No automatic host switch or new workflow start.
- Completion footer: standard advisory footer for engineer/orchestrator completion surfaces with context state, workflow ids, artifact pointers, recommended next work, and exact next-session command or prompt.
- Deep peer smoke for `runtime:doctor`: explicit opt-in only. The first PR accepts `--deep-peer-smoke` but does not execute peer agents.

## Boundaries

- `plugins/companions` remains a script-only library plugin.
- Runtime owns cross-plugin host/runtime truth; it does not become an engineer or orchestrator command bundle.
- Codex manual-hook and permission limits must stay visible in output instead of being treated as host parity.
