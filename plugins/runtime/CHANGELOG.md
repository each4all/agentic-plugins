# Changelog

## Unreleased

### Features

- Add `runtime:context`, an artifact-only context hygiene scaffold that writes summary, risk, artifact pointers, and next-session handoff files under `.agentic-plugins/runs/context/` without mutating host session context.
- Add `runtime:context check`, a read-only explicit context budget check that computes green/yellow/red risk without creating artifacts or mutating host session context.
- Add `runtime:context status --latest`, a read-only latest handoff lookup with artifact age and stale-state reporting.

## [0.17.0](https://github.com/each4all/agentic-plugins/compare/plugin-runtime-v0.16.0...plugin-runtime-v0.17.0) (2026-05-14)


### Features

* **plugin/runtime:** support manual consensus peer lanes ([5ad6fb6](https://github.com/each4all/agentic-plugins/commit/5ad6fb6adc04059435970c30e99bf8cf5166394d))

## [0.16.0](https://github.com/each4all/agentic-plugins/compare/plugin-runtime-v0.15.0...plugin-runtime-v0.16.0) (2026-05-14)


### Features

* **plugin/runtime:** clarify Codex cache materialization ([44ec1b1](https://github.com/each4all/agentic-plugins/commit/44ec1b116839eb1c2ae4236a89b330a935dfad89))

## [0.15.0](https://github.com/each4all/agentic-plugins/compare/plugin-runtime-v0.14.0...plugin-runtime-v0.15.0) (2026-05-14)


### Features

* **plugin/runtime:** add consensus guidance to footer ([ce9f390](https://github.com/each4all/agentic-plugins/commit/ce9f390df26f8e0fb962ead4d966a2a977a80272))

## [0.14.0](https://github.com/each4all/agentic-plugins/compare/plugin-runtime-v0.13.1...plugin-runtime-v0.14.0) (2026-05-14)


### Features

* **plugin/runtime:** guide consensus status next actions ([e08146b](https://github.com/each4all/agentic-plugins/commit/e08146bcb22acc517918adebe42608a0e54a3b8f))

## [0.13.1](https://github.com/each4all/agentic-plugins/compare/plugin-runtime-v0.13.0...plugin-runtime-v0.13.1) (2026-05-14)


### Bug Fixes

* **plugin/runtime:** report Codex marketplace-cache-only state ([bd3ff0e](https://github.com/each4all/agentic-plugins/commit/bd3ff0eab6219235d95b1e384a0d9aedc5435641))

## [0.13.0](https://github.com/each4all/agentic-plugins/compare/plugin-runtime-v0.12.2...plugin-runtime-v0.13.0) (2026-05-14)


### Features

* **plugin/runtime:** report context source freshness ([1674294](https://github.com/each4all/agentic-plugins/commit/1674294ae37b1bddddd8154f161fc6b8d9cb2fd9))

## [0.12.2](https://github.com/each4all/agentic-plugins/compare/plugin-runtime-v0.12.1...plugin-runtime-v0.12.2) (2026-05-14)


### Bug Fixes

* **plugin/runtime:** classify operator precondition failures ([3d6ffb3](https://github.com/each4all/agentic-plugins/commit/3d6ffb39565efe7821bbeea9665e5c95c7c12541))

## [0.12.1](https://github.com/each4all/agentic-plugins/compare/plugin-runtime-v0.12.0...plugin-runtime-v0.12.1) (2026-05-14)


### Bug Fixes

* **plugin/runtime:** harden consensus timeout UX ([0a8733f](https://github.com/each4all/agentic-plugins/commit/0a8733fdba4519de38a7d3e5fd53d864e6b41d85))

## [0.12.0](https://github.com/each4all/agentic-plugins/compare/plugin-runtime-v0.11.0...plugin-runtime-v0.12.0) (2026-05-13)


### Features

* **plugin/runtime:** execute consensus companions ([29a2e9d](https://github.com/each4all/agentic-plugins/commit/29a2e9d442269fc70075f58ffe5322af2064e1a9))

## [0.11.0](https://github.com/each4all/agentic-plugins/compare/plugin-runtime-v0.10.0...plugin-runtime-v0.11.0) (2026-05-13)


### Features

* **plugin/runtime:** persist settings execution artifacts ([3c1157f](https://github.com/each4all/agentic-plugins/commit/3c1157f4392d38c42b1dbfab4e0ecf015888cd00))

## [0.10.0](https://github.com/each4all/agentic-plugins/compare/plugin-runtime-v0.9.0...plugin-runtime-v0.10.0) (2026-05-13)


### Features

* **plugin/runtime:** execute settings plugin management ([0cdb894](https://github.com/each4all/agentic-plugins/commit/0cdb894fa26ce5a83176190e87a1ee7c7d699220))

## [0.9.0](https://github.com/each4all/agentic-plugins/compare/plugin-runtime-v0.8.0...plugin-runtime-v0.9.0) (2026-05-13)


### Features

* **plugin/runtime:** project effective settings resolution ([c5475a0](https://github.com/each4all/agentic-plugins/commit/c5475a0966d5c1898418f6f69e04e5af8b0bcda3))

## [0.8.0](https://github.com/each4all/agentic-plugins/compare/plugin-runtime-v0.7.0...plugin-runtime-v0.8.0) (2026-05-13)


### Features

* **plugin/runtime:** add doctor readiness matrix ([857ebc7](https://github.com/each4all/agentic-plugins/commit/857ebc788770650888609c73079fe1b7c1b73a4b))
* **plugin/runtime:** add workflow storage migration command ([5d974ed](https://github.com/each4all/agentic-plugins/commit/5d974ed37805e13d66803360338a18003699febf))
* **plugin/runtime:** diagnose workflow storage homes ([6f42f4c](https://github.com/each4all/agentic-plugins/commit/6f42f4c8ae5ca6d9238a1bb28d6c27be02c8ec4c))


### Bug Fixes

* **plugin/runtime:** accept migrate subcommand after flags ([550e93d](https://github.com/each4all/agentic-plugins/commit/550e93d91b0a4dd61f9f99a19cece513a833899b))
* **plugin/runtime:** report codex hook feature parity ([c330698](https://github.com/each4all/agentic-plugins/commit/c330698e0c6183e4c70026631779880710e93857))

## [0.7.0](https://github.com/each4all/agentic-plugins/compare/plugin-runtime-v0.6.0...plugin-runtime-v0.7.0) (2026-05-13)


### Features

* **plugin/runtime:** add doctor permission proof ([eace036](https://github.com/each4all/agentic-plugins/commit/eace036b62622616dd522206ccf2e1ea9ca2d30a))
* **plugin/runtime:** add host parity diagnostics ([6073f30](https://github.com/each4all/agentic-plugins/commit/6073f3099d97b88df08db64f841a603025002af2))
* **plugin/runtime:** add PR handling readiness footer ([7aa2929](https://github.com/each4all/agentic-plugins/commit/7aa292936ec1551f0cf0d272604c8193ae2e416c))
* **plugin/runtime:** validate artifact ignore policy ([dfae3fc](https://github.com/each4all/agentic-plugins/commit/dfae3fcff2b8f4fe9af2f91c79a3fada971bc4d3))

## [0.6.0](https://github.com/each4all/agentic-plugins/compare/plugin-runtime-v0.5.0...plugin-runtime-v0.6.0) (2026-05-13)


### Features

* **plugin/runtime:** add doctor deep peer smoke executor ([0c784c3](https://github.com/each4all/agentic-plugins/commit/0c784c3b2552b336a01dc9e67851e86a0ccd3642))

## [0.5.0](https://github.com/each4all/agentic-plugins/compare/plugin-runtime-v0.4.0...plugin-runtime-v0.5.0) (2026-05-13)


### Features

* **plugin/runtime:** expand footer context lookup ([b1f620c](https://github.com/each4all/agentic-plugins/commit/b1f620c90610f704e5f06578de086d69a83a4b19))

## [0.4.0](https://github.com/each4all/agentic-plugins/compare/plugin-runtime-v0.3.0...plugin-runtime-v0.4.0) (2026-05-13)


### Features

* **plugin/runtime:** add doctor sandbox permission probe ([9576b57](https://github.com/each4all/agentic-plugins/commit/9576b572fe92ba9a0a8892489ae47399be679cb1))

## [0.3.0](https://github.com/each4all/agentic-plugins/compare/plugin-runtime-v0.2.0...plugin-runtime-v0.3.0) (2026-05-13)


### Features

* **plugin/runtime:** add plan-only doctor deep peer smoke preflight ([8ba23f3](https://github.com/each4all/agentic-plugins/commit/8ba23f3a829f6c181acde92e1c0e0b80dfc1bc91))

## [0.2.0](https://github.com/each4all/agentic-plugins/compare/plugin-runtime-v0.1.0...plugin-runtime-v0.2.0) (2026-05-13)


### Features

* **plugin/runtime:** add completion footer helper ([5cc428b](https://github.com/each4all/agentic-plugins/commit/5cc428b574ae67a7a7d09aa493712fe463ef6e84))
* **plugin/runtime:** add consensus artifact scaffold ([46c6b99](https://github.com/each4all/agentic-plugins/commit/46c6b9960d89a93dcd7f8c03df15b159bc446b7f))
* **plugin/runtime:** add context artifact scaffold ([c909f24](https://github.com/each4all/agentic-plugins/commit/c909f2411e234c4766d05899a9e7355469708735))
* **plugin/runtime:** add context budget check ([8908e84](https://github.com/each4all/agentic-plugins/commit/8908e84d940e26ae5717f0d5b77889b551edc503))
* **plugin/runtime:** add latest context status lookup ([fb84276](https://github.com/each4all/agentic-plugins/commit/fb84276299194bd079c9ccbbb418e7f600d2ffec))
* **plugin/runtime:** add read-only doctor ([13fed73](https://github.com/each4all/agentic-plugins/commit/13fed73e0e9a66a08c14710a3a60eb5787044bc4))
* **plugin/runtime:** add settings planner ([cb9bb45](https://github.com/each4all/agentic-plugins/commit/cb9bb458519a1c1fc11b210fd726da5d92861c00))

## 0.1.0

- Initial runtime L1 framework primitive scaffold.
- Add read-only `runtime:doctor` command and Codex skill wrapper.
- Report host CLI/auth state, marketplace/cache discovery, companion contract compatibility, model/effort observation, companion readiness, and workflow/peer-run ledger health.
