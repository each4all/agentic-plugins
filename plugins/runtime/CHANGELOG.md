# Changelog

## Unreleased

### Features

- Add `runtime:context`, an artifact-only context hygiene scaffold that writes summary, risk, artifact pointers, and next-session handoff files under `.agentic-plugins/runs/context/` without mutating host session context.
- Add `runtime:context check`, a read-only explicit context budget check that computes green/yellow/red risk without creating artifacts or mutating host session context.
- Add `runtime:context status --latest`, a read-only latest handoff lookup with artifact age and stale-state reporting.

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
