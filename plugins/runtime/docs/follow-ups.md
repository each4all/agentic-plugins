# Runtime Follow-ups

ADR-0024 defines more than the first `doctor` and `settings` PRs. This file keeps the deferred surfaces explicit so runtime operator commands do not grow into hidden workflow, host-native config, or plugin-install mutation by accident.

## Deferred to follow-up PRs

- Automatic plugin install/update apply mode: first settings only recommends host-native install/update commands. A later PR may add an explicit apply boundary for plugin management.
- Dynamic peer consensus: budget-driven fanout, disagreement extraction, targeted rebuttal/verification, synthesis, and bounded iteration. Raw peer outputs stay in artifacts; the main session receives synthesized results and evidence pointers.
- Context hygiene: main-session context budget checks and artifact-pointer summaries. No automatic host switch or new workflow start.
- Completion footer: standard advisory footer for engineer/orchestrator completion surfaces with context state, workflow ids, artifact pointers, recommended next work, and exact next-session command or prompt.
- Deep peer smoke for `runtime:doctor`: explicit opt-in only. The first PR accepts `--deep-peer-smoke` but does not execute peer agents.
- Sandbox permission proof: explicit smoke/probe only. Settings must not silently relax sandbox or approval policy.

## Boundaries

- `plugins/companions` remains a script-only library plugin.
- Runtime owns cross-plugin host/runtime truth; it does not become an engineer or orchestrator command bundle.
- Codex manual-hook and permission limits must stay visible in output instead of being treated as host parity.
