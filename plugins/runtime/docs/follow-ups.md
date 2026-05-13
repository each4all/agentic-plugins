# Runtime Follow-ups

ADR-0024 defines more than the first `doctor`, `settings`, consensus, and context scaffold PRs. This file keeps the deferred surfaces explicit so runtime operator commands do not grow into hidden workflow, host-native config, context mutation, or plugin-install mutation by accident.

## Deferred to follow-up PRs

- Plugin management beyond the explicit settings executor: `runtime:settings --execute-plugin-management` can run allowlisted host-native plugin install/update/add/upgrade commands, but broader host-native config apply, plugin uninstall, authentication automation, sandbox/permission changes, richer retry policy, and persistent execution artifacts remain follow-up scope.
- Automatic peer execution for consensus: the first consensus PR creates and updates runtime-owned run artifacts, but peer execution remains manual/host-native. A later PR may add an explicit executor boundary for companion dispatch, cancellation, and deeper smoke evidence.
- Context automation beyond read-only checks: automatic capture triggers beyond the current `runtime:context` scaffold and explicit budget check. No automatic host switch, new workflow start, or host-session compaction.
- Completion footer command-surface integration beyond latest context lookup and PR handling readiness: the helper remains advisory and pointer-only, can read the latest existing `runtime:context` artifact with stale metadata, and can render PR handling readiness. Later PRs may add richer command-surface integration, but must still avoid automatic context mutation, automatic session start, raw peer/consensus output in the main session, or automatic commit/push/PR mutation.
- Deep peer smoke evidence beyond the bounded `runtime:doctor` executor: current doctor output includes a plan-only `--deep-peer-smoke` preflight and an explicit `--execute-deep-peer-smoke` companion-contract executor that omits raw peer stdout. Richer artifact retention, cancellation, or multi-round smoke policy remains follow-up scope.
- Permission proof evidence beyond the bounded `runtime:doctor` executor: current doctor output includes `--permission-proof` plan-only preflight and an explicit `--permission-proof --execute-permission-proof` companion-contract executor under host-native permission defaults. Richer artifact retention, cancellation, multi-operation permission matrices, or any settings-driven sandbox/approval changes remain follow-up scope. Settings must not silently relax sandbox or approval policy.

## Boundaries

- `plugins/companions` remains a script-only library plugin.
- Runtime owns cross-plugin host/runtime truth; it does not become an engineer or orchestrator command bundle.
- Codex manual-hook and permission limits must stay visible in output instead of being treated as host parity.
