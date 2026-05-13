# Runtime Follow-ups

ADR-0024 defines more than the first `doctor`, `settings`, consensus, and context scaffold PRs. This file keeps the deferred surfaces explicit so runtime operator commands do not grow into hidden workflow, host-native config, context mutation, or plugin-install mutation by accident.

## Deferred to follow-up PRs

- Automatic plugin install/update apply mode: first settings only recommends host-native install/update commands. A later PR may add an explicit apply boundary for plugin management.
- Automatic peer execution for consensus: the first consensus PR creates and updates runtime-owned run artifacts, but peer execution remains manual/host-native. A later PR may add an explicit executor boundary for companion dispatch, cancellation, and deeper smoke evidence.
- Context automation beyond read-only checks: automatic capture triggers beyond the current `runtime:context` scaffold and explicit budget check. No automatic host switch, new workflow start, or host-session compaction.
- Completion footer expansion: the first helper is advisory and pointer-only. Later PRs may add richer integration, but must still avoid automatic context mutation, automatic session start, and raw peer/consensus output in the main session.
- Deep peer smoke execution for `runtime:doctor`: explicit opt-in only. Current doctor output includes a plan-only `--deep-peer-smoke` preflight, but it still does not execute peer agents.
- Sandbox permission executor proof: current `runtime:doctor --sandbox-permission-probe` is an explicit read-only preflight and records `peer_execution=false`. A later PR may add an executor proof only behind a separate explicit boundary. Settings must not silently relax sandbox or approval policy.

## Boundaries

- `plugins/companions` remains a script-only library plugin.
- Runtime owns cross-plugin host/runtime truth; it does not become an engineer or orchestrator command bundle.
- Codex manual-hook and permission limits must stay visible in output instead of being treated as host parity.
