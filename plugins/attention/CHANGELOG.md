# Changelog — plugin-attention

All notable changes to the `attention` plugin are documented here.

## [0.5.0](https://github.com/each4all/agentic-plugins/compare/plugin-attention-v0.4.1...plugin-attention-v0.5.0) (2026-07-14)


### Features

* **plugin/attention:** enrich founder/designer terminal Stops via the four-persona sensor set (ADR-0043 §3) ([4764811](https://github.com/each4all/agentic-plugins/commit/476481164fdd15c114efa3df5b37f93aa97ac276))

## [0.4.1](https://github.com/each4all/agentic-plugins/compare/plugin-attention-v0.4.0...plugin-attention-v0.4.1) (2026-07-11)


### Bug Fixes

* **plugin/attention:** relocate Claude hook registration to a manifest-declared adapters path ([#546](https://github.com/each4all/agentic-plugins/issues/546)) ([ceb2fb9](https://github.com/each4all/agentic-plugins/commit/ceb2fb91c53bf52e404e7bf69c3d4db2c2a4879a))

## [0.4.0](https://github.com/each4all/agentic-plugins/compare/plugin-attention-v0.3.1...plugin-attention-v0.4.0) (2026-07-07)


### Features

* **attention:** born opt-in closed-vocabulary headline token on Stop workflow-terminal events (ADR-0041 §3a producer-headline) ([#513](https://github.com/each4all/agentic-plugins/issues/513)) ([df364a9](https://github.com/each4all/agentic-plugins/commit/df364a99a450e855aad8605dd23284d7d61d4ce6))

## [0.3.1](https://github.com/each4all/agentic-plugins/compare/plugin-attention-v0.3.0...plugin-attention-v0.3.1) (2026-07-06)


### Bug Fixes

* **attention:** widen egress emitter spawn timeout to cover the 8s notify budget ([79761d6](https://github.com/each4all/agentic-plugins/commit/79761d63db827d489238123b91dfeae3103ceab7))

## [0.3.0](https://github.com/each4all/agentic-plugins/compare/plugin-attention-v0.2.0...plugin-attention-v0.3.0) (2026-07-05)


### Features

* **attention:** ADR-0041 §4 populate cross-machine routing fields on sensor events ([23de1b1](https://github.com/each4all/agentic-plugins/commit/23de1b1162e4ceda399cd682ad36350ffaee1bf0))

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
