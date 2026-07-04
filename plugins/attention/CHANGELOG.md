# Changelog — plugin-attention

All notable changes to the `attention` plugin are documented here.

## [0.2.0](https://github.com/each4all/agentic-plugins/compare/plugin-attention-v0.1.0...plugin-attention-v0.2.0) (2026-07-04)


### Features

* **plugin/attention:** hook-only L1 Claude attention sensors per ADR-0040 §3 ([0ec4144](https://github.com/each4all/agentic-plugins/commit/0ec41448a7f8235cb0ea37530f445c386d32f8c8))

## 0.1.0 (initial scaffold seed)

- Hook-only L1 attention sensor plugin per ADR-0040 §3: Claude
  `Notification` (permission_prompt → approval/urgent, idle_prompt →
  idle), `Stop` (workflow-terminal behind the freshness-checked
  session-handoff projection gate, else bare turn-complete), and
  `SubagentStop` (subagent-complete) sensors emitting into the runtime
  notification pipeline via a version-gated discover-runtime ladder
  (runtime ≥ 0.71.0). No Codex hooks at v1.
