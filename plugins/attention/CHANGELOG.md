# Changelog — plugin-attention

All notable changes to the `attention` plugin are documented here.

## [0.9.0](https://github.com/each4all/agentic-plugins/compare/plugin-attention-v0.8.0...plugin-attention-v0.9.0) (2026-07-22)


### Features

* **plugin/attention:** ADR-0047 §2/§3/§9 bounded Stop finality classifier + §4 headline producers ([365fb96](https://github.com/each4all/agentic-plugins/commit/365fb9648755b7605d4f30d75b5ce58266bbd326))


### Bug Fixes

* **plugin/attention:** fold codex Review findings — TOCTOU-free bounded reads, scan-completeness hardening ([c6465d8](https://github.com/each4all/agentic-plugins/commit/c6465d8eb4a0fa849ea605684b7e06a15aa9c089))

## [0.8.0](https://github.com/each4all/agentic-plugins/compare/plugin-attention-v0.7.1...plugin-attention-v0.8.0) (2026-07-21)


### Features

* **plugin/attention:** mirror response-needed into the copy-not-import notify vocabulary (ADR-0047 §1) ([952af14](https://github.com/each4all/agentic-plugins/commit/952af142f43e6cb316fd216aaf3eebe37157baed))

## [0.7.1](https://github.com/each4all/agentic-plugins/compare/plugin-attention-v0.7.0...plugin-attention-v0.7.1) (2026-07-20)


### Bug Fixes

* **plugin/attention:** SIGKILL kill bound on both Stop-seam spawns + build-metadata-safe semver copy ([eb480f3](https://github.com/each4all/agentic-plugins/commit/eb480f36b3e2694842ac368c2a1dcdebbb256454))

## [0.7.0](https://github.com/each4all/agentic-plugins/compare/plugin-attention-v0.6.0...plugin-attention-v0.7.0) (2026-07-20)


### Features

* **plugin/attention:** ADR-0045 S9 — SessionStart entry sensor + entry-brief floor pin ([9460682](https://github.com/each4all/agentic-plugins/commit/946068226dae96aa042d2ebc626710f64cde5470))

## [0.6.0](https://github.com/each4all/agentic-plugins/compare/plugin-attention-v0.5.0...plugin-attention-v0.6.0) (2026-07-20)


### Features

* **plugin/attention:** S5 — Stop sensor session-capture spawn, publisher floor 0.82.0 pin, hot-path budget contract (ADR-0044 §2/§13) ([#595](https://github.com/each4all/agentic-plugins/issues/595)) ([3b8ed8d](https://github.com/each4all/agentic-plugins/commit/3b8ed8d64b8e2c1f03950e120e04d683c7cd0532))

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
