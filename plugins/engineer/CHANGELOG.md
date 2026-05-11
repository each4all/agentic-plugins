# Changelog

## [0.7.0](https://github.com/each4all/agentic-plugins/compare/plugin-engineer-v0.6.0...plugin-engineer-v0.7.0) (2026-05-11)


### Features

* **orchestrator+engineer:** /finalize + /abort + macro stop-archive A1-A4 (ADR-0019 PR-E) ([#67](https://github.com/each4all/agentic-plugins/issues/67)) ([c0d5c0b](https://github.com/each4all/agentic-plugins/commit/c0d5c0b622d690ae3a23f83ba5c317089fe4be6b))
* **orchestrator+engineer:** /next + /done dispatch + Phase 0 parent-linkage (ADR-0019 PR-D) ([#66](https://github.com/each4all/agentic-plugins/issues/66)) ([084848a](https://github.com/each4all/agentic-plugins/commit/084848ad829386ccf67649699bea79bcd9ae426d))
* **plugins/engineer:** parent-writeback helper + Stop hook integration (ADR-0019 PR-C) ([#65](https://github.com/each4all/agentic-plugins/issues/65)) ([7c4d628](https://github.com/each4all/agentic-plugins/commit/7c4d62819b9b0a1619c8df4d7fda6deabb625867))
* **plugins/engineer:** schema 1.1 parent-linkage fields (ADR-0019 PR-A) ([#61](https://github.com/each4all/agentic-plugins/issues/61)) ([fa2a9c7](https://github.com/each4all/agentic-plugins/commit/fa2a9c7b6100a684d7699e63f3590d39492070da))

## [0.6.0](https://github.com/each4all/agentic-plugins/compare/plugin-engineer-v0.5.0...plugin-engineer-v0.6.0) (2026-05-08)


### Features

* **engineer:** /engineer:checkpoint + schema 1.1 latest_checkpoint emit (ADR-0017 PR3) ([304e3d9](https://github.com/each4all/agentic-plugins/commit/304e3d9e9e640664ffda77f7a14cd2240f0e3e3a))
* **plugins/engineer:** /engineer:checkpoint + schema 1.1 latest_checkpoint emit (ADR-0017 PR3) ([dabd898](https://github.com/each4all/agentic-plugins/commit/dabd898659eed7251792a19c2da17fbbc4e71e85))
* **plugins/engineer:** /engineer:peer-now + ensemble_results wiring (ADR-0017 PR5) ([#49](https://github.com/each4all/agentic-plugins/issues/49)) ([6571bd4](https://github.com/each4all/agentic-plugins/commit/6571bd4af0f20d1c71aa010c2b55bc6bd12ddbb6))
* **plugins/engineer:** /engineer:resume (ADR-0017 PR2) ([595acd7](https://github.com/each4all/agentic-plugins/commit/595acd776bdfe24f3937b73c532363e1706aa784))
* **plugins/engineer:** /engineer:resume (ADR-0017 PR2) ([465858a](https://github.com/each4all/agentic-plugins/commit/465858ab1dcc1fa7287fa140994a72755131ab8d))
* **plugins/engineer:** /engineer:resume drift dirty case enrichment (ADR-0018 §sub-3) ([#51](https://github.com/each4all/agentic-plugins/issues/51)) ([eb3c485](https://github.com/each4all/agentic-plugins/commit/eb3c4857738f1346f758d7a2a81417f15263bfe7))
* **plugins/engineer:** branch-keyed active workflow lookup (ADR-0018 §sub-2) ([#52](https://github.com/each4all/agentic-plugins/issues/52)) ([9128c95](https://github.com/each4all/agentic-plugins/commit/9128c955839015bcfa65dfa60b80d7e1b3f2424f))
* **plugins/engineer:** schema 1.1 reader + ensemble bookkeeping helpers (ADR-0017 PR1) ([3c15753](https://github.com/each4all/agentic-plugins/commit/3c1575348312b608713a14454b16db0165568f66))
* **plugins/engineer:** schema 1.1 reader + ensemble bookkeeping helpers (ADR-0017 PR1) ([67ca92a](https://github.com/each4all/agentic-plugins/commit/67ca92adde76671ece289287a6e05770a957a792))
* **plugins/engineer:** Stop hook auto-archive (ADR-0017 PR4) ([#48](https://github.com/each4all/agentic-plugins/issues/48)) ([cfb6fa6](https://github.com/each4all/agentic-plugins/commit/cfb6fa6c9d8f5c45d9a5a2c3b90526d83b4e020b))

## [0.5.0](https://github.com/each4all/agentic-plugins/compare/plugin-engineer-v0.4.0...plugin-engineer-v0.5.0) (2026-05-06)


### Features

* **engineer:** static Claude subagents + Tier α docs truth fixes ([51d7dbd](https://github.com/each4all/agentic-plugins/commit/51d7dbdedfe9aebeab38d5cc034aa501d9952dc9))
* **plugins/engineer:** static Claude adapter subagent definitions ([2401da6](https://github.com/each4all/agentic-plugins/commit/2401da62d5bb730d2671a8e962b54106c1cbeee9))

## [0.4.0](https://github.com/each4all/agentic-plugins/compare/plugin-engineer-v0.3.0...plugin-engineer-v0.4.0) (2026-05-06)


### ⚠ BREAKING CHANGES

* **plugin/research:** plugins/research is removed. Any consumer that had the plugin installed must migrate to engineer:investigate cited-brief profile. /research:research command is no longer available; equivalent flow is /engineer:investigate --profile=cited-brief <topic> (or natural language with cited-brief trigger phrases for auto-mode). research_brief.md artifacts saved under the previous plugin remain readable.

### Features

* **plugin/engineer:** add cited-brief profile to investigate (absorbs plugins/research) ([4077552](https://github.com/each4all/agentic-plugins/commit/40775527a20ac028666e76d86f1cdeea3711c138))
* **plugin/engineer:** validation + dogfood + Stage 2 exit evidence (Stage 2 Deliverable E) ([#32](https://github.com/each4all/agentic-plugins/issues/32)) ([31149bb](https://github.com/each4all/agentic-plugins/commit/31149bb688bfbca6616f88555e909805129c3b08))


### Miscellaneous Chores

* **plugin/research:** archive at Stage 2.5+ (timeline collapse per ADR-0014 Amendment) ([28b5eb8](https://github.com/each4all/agentic-plugins/commit/28b5eb80b7fb2a2b742032ac1090b3c4a21e12cd))

## [0.3.0](https://github.com/each4all/agentic-plugins/compare/plugin-engineer-v0.2.0...plugin-engineer-v0.3.0) (2026-05-05)


### Features

* **plugin/engineer:** adapters + minimal continuity (Stage 2 Deliverable D) ([#30](https://github.com/each4all/agentic-plugins/issues/30)) ([af12326](https://github.com/each4all/agentic-plugins/commit/af1232641404d47fd74767025ffb3f10f07a6e47))

## [0.2.0](https://github.com/each4all/agentic-plugins/compare/plugin-engineer-v0.1.0...plugin-engineer-v0.2.0) (2026-05-05)


### Features

* **plugin/engineer:** scaffold L3 persona plugin with 6 cognitive verbs (Stage 2 Deliverable C) ([#27](https://github.com/each4all/agentic-plugins/issues/27)) ([3040a13](https://github.com/each4all/agentic-plugins/commit/3040a13c99e43b7dd9e1f25d00d800051e69b38e))

## Changelog
