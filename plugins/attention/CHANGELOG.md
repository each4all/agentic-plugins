# Changelog — plugin-attention

All notable changes to the `attention` plugin are documented here.

## 0.1.0 (initial scaffold seed)

- Hook-only L1 attention sensor plugin per ADR-0040 §3: Claude
  `Notification` (permission_prompt → approval/urgent, idle_prompt →
  idle), `Stop` (workflow-terminal behind the freshness-checked
  session-handoff projection gate, else bare turn-complete), and
  `SubagentStop` (subagent-complete) sensors emitting into the runtime
  notification pipeline via a version-gated discover-runtime ladder
  (runtime ≥ 0.71.0). No Codex hooks at v1.
