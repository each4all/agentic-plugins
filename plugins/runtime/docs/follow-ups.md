# Runtime Follow-ups

ADR-0024 defines more than the first `doctor`, `settings`, consensus, and context scaffold PRs. This file keeps the deferred surfaces explicit so runtime operator commands do not grow into hidden workflow, host-native config, context mutation, or plugin-install mutation by accident.

## Deferred to follow-up PRs

- Plugin management beyond the explicit settings executor: `runtime:settings --execute-plugin-management` can run allowlisted host-native plugin install/update/add/upgrade commands and persist sanitized execution artifacts, but broader host-native config apply, plugin uninstall, authentication automation, sandbox/permission changes, richer retry policy, and deeper retention/cancellation policy remain follow-up scope.
- Consensus executor depth beyond the explicit boundary: `runtime:consensus execute --execute` can dispatch allowlisted companion peers, store raw stdout as artifacts, maintain per-peer progress metadata, classify permission/sandbox/auth preconditions as `operator_action_required`, and classify sanitized failure/retry metadata with bounded timeout remediation. Follow-up scope remains richer cancellation, deeper peer smoke matrices, automated synthesis, and broader peer selection policy.
- Worktree execution beyond read-only planning: `runtime:worktree plan` can inspect current git/worktree state and suggest commands, but branch creation, `git worktree add/remove/prune`, checkout switching, commit, push, and PR creation remain explicit operator actions outside runtime.
- Context automation beyond read-only checks: automatic capture triggers beyond the current `runtime:context` scaffold and explicit budget check. No automatic host switch, new workflow start, or host-session compaction.
- Completion footer command-surface integration beyond latest context lookup, handoff guidance, and PR handling readiness: the helper remains advisory and pointer-only, can read the latest existing `runtime:context` artifact with stale/source metadata plus guidance, and can render PR handling readiness. Later PRs may add richer command-surface integration, but must still avoid automatic context mutation, automatic session start, raw peer/consensus output in the main session, or automatic commit/push/PR mutation.
- Deep peer smoke evidence beyond the bounded `runtime:doctor` executor: current doctor output includes a plan-only `--deep-peer-smoke` preflight, an explicit `--execute-deep-peer-smoke` companion-contract executor that omits raw peer stdout, and direction-level execution readiness in the readiness matrix. Permission, sandbox, and child-process auth blocks are operator preconditions rather than runtime implementation failures. Richer artifact retention, cancellation, or multi-round smoke policy remains follow-up scope.
- Permission proof evidence beyond the bounded `runtime:doctor` executor: current doctor output includes `--permission-proof` plan-only preflight, an explicit `--permission-proof --execute-permission-proof` companion-contract executor under host-native permission defaults, and direction-level execution readiness in the readiness matrix. Operator preconditions are surfaced as `operator_action_required` with `permission_required`, `sandbox_blocked`, or `auth_required` kinds. Richer artifact retention, cancellation, multi-operation permission matrices, or any settings-driven sandbox/approval changes remain follow-up scope. Settings must not silently relax sandbox or approval policy.

## Boundaries

- `plugins/companions` remains a script-only library plugin.
- Runtime owns cross-plugin host/runtime truth; it does not become an engineer or orchestrator command bundle.
- Codex manual-hook and permission limits must stay visible in output instead of being treated as host parity.
- Consensus execution must stay bounded by explicit `--execute`, max rounds, max peers, process budget, and timeout caps. Runtime must not add automatic unbounded loops or relax host permissions.
- Worktree planning must remain read-only unless a future PR adds a separate explicit execution boundary with dry-run defaults.
