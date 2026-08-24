# Changelog

## [0.3.5](https://github.com/each4all/agentic-plugins/compare/plugin-designer-v0.3.4...plugin-designer-v0.3.5) (2026-08-24)


### Bug Fixes

* **plugin/designer:** dirty-tree gates see untracked files under status.showUntrackedFiles=no ([d0828e4](https://github.com/each4all/agentic-plugins/commit/d0828e4cda5503cdf98833eca5ce31558c6a0b9d))
* **plugin/designer:** state when Stop evaluates the archive gates ([e1406c9](https://github.com/each4all/agentic-plugins/commit/e1406c9eea6bf3e3a6bf0ed489520c36dfc71d22))

## [0.3.4](https://github.com/each4all/agentic-plugins/compare/plugin-designer-v0.3.3...plugin-designer-v0.3.4) (2026-08-16)


### Bug Fixes

* **plugin/designer:** drop the withdrawn todo-tool dependency from command runbooks ([0cb184e](https://github.com/each4all/agentic-plugins/commit/0cb184e5b0add96e6986be2da843d9bc97cb0c23))

## [0.3.3](https://github.com/each4all/agentic-plugins/compare/plugin-designer-v0.3.2...plugin-designer-v0.3.3) (2026-08-08)


### Bug Fixes

* **plugin/designer:** drop the future-session promise from the checkpoint description ([9799039](https://github.com/each4all/agentic-plugins/commit/97990393217474d2ccb0e42013b051529a59639b))

## [0.3.2](https://github.com/each4all/agentic-plugins/compare/plugin-designer-v0.3.1...plugin-designer-v0.3.2) (2026-08-08)


### Bug Fixes

* **plugin/designer:** scope checkpoint re-injection to post-compact on both hosts ([b4208c6](https://github.com/each4all/agentic-plugins/commit/b4208c6c56307f1bf01b0ecad9c8c018da74c83d))

## [0.3.1](https://github.com/each4all/agentic-plugins/compare/plugin-designer-v0.3.0...plugin-designer-v0.3.1) (2026-08-03)


### Bug Fixes

* **plugin/designer:** make the peer-run sweep preview state what --apply deletes ([b5766d7](https://github.com/each4all/agentic-plugins/commit/b5766d7f52fef2b68b39e1b23a885a9335f19318))
* **plugin/designer:** re-verify a peer run immediately before deleting it ([f2448e4](https://github.com/each4all/agentic-plugins/commit/f2448e4204ffae64f3338eed761cbb854f5be863))

## [0.3.0](https://github.com/each4all/agentic-plugins/compare/plugin-designer-v0.2.1...plugin-designer-v0.3.0) (2026-07-13)


### Features

* **plugin/designer:** emit terminal handoff sidecar + completion footer (ADR-0043 S4) ([2df14d5](https://github.com/each4all/agentic-plugins/commit/2df14d560a9f9fcde9d496b46171dcb097c5f07a))

## [0.2.1](https://github.com/each4all/agentic-plugins/compare/plugin-designer-v0.2.0...plugin-designer-v0.2.1) (2026-07-12)


### Bug Fixes

* **plugin/designer:** register peer-runner child observers synchronously with spawn ([be86355](https://github.com/each4all/agentic-plugins/commit/be86355ec944e5033897c9dc304b65e618a89a03))

## [0.2.0](https://github.com/each4all/agentic-plugins/compare/plugin-designer-v0.1.0...plugin-designer-v0.2.0) (2026-07-09)


### Features

* **plugin/designer:** copy-trim non-dispatch workflow machinery + hooks (ADR-0042 PR2) ([#522](https://github.com/each4all/agentic-plugins/issues/522)) ([1d38cbe](https://github.com/each4all/agentic-plugins/commit/1d38cbe363bf088a7723dae6ec233763d785a3bb))
* **plugin/designer:** critique skill — quality lenses + vision/privacy/criteria (ADR-0042 PR5A) ([#525](https://github.com/each4all/agentic-plugins/issues/525)) ([20f2a09](https://github.com/each4all/agentic-plugins/commit/20f2a0945164cd2bcbed4e9fbb3214b344d31575))
* **plugin/designer:** decide + compose skills + decide engine (ADR-0042 PR4) ([#524](https://github.com/each4all/agentic-plugins/issues/524)) ([74dd623](https://github.com/each4all/agentic-plugins/commit/74dd62326e85d72116af702d5dd9714503d6c532))
* **plugin/designer:** investigate+frame + design-brief contract + SD4 privacy gate (ADR-0042 PR3) ([#523](https://github.com/each4all/agentic-plugins/issues/523)) ([2aeb41d](https://github.com/each4all/agentic-plugins/commit/2aeb41d8ea5c93bbe9d45076c3be476278dff68c))
* **plugin/designer:** real-topic dogfood, ADR-0042 Accepted flip, de-incubation (ADR-0042 PR7) ([#529](https://github.com/each4all/agentic-plugins/issues/529)) ([83f1c3c](https://github.com/each4all/agentic-plugins/commit/83f1c3ca606c6098f6de598dec5b43f657a0f665))
* **plugin/designer:** refine skill — bounded convergence loop + Refine-verify ensemble (ADR-0042 PR5B) ([#526](https://github.com/each4all/agentic-plugins/issues/526)) ([7a5a6dd](https://github.com/each4all/agentic-plugins/commit/7a5a6dd072bff630783b2a639619dc0c557b3782))
* **plugin/designer:** scaffold designer persona plugin (ADR-0042 PR1) ([#520](https://github.com/each4all/agentic-plugins/issues/520)) ([460a6b8](https://github.com/each4all/agentic-plugins/commit/460a6b859e34b4736a74022a5ec186097212ee8b))
* **plugin/designer:** start macro + 3 meta skills + shared references + L4 profiles (ADR-0042 PR6) ([#527](https://github.com/each4all/agentic-plugins/issues/527)) ([5d8ae8d](https://github.com/each4all/agentic-plugins/commit/5d8ae8dfe1f4185ed3924610895c8a2990211118))

## 0.1.0 (initial scaffold seed)

- Atomic scaffold for the `designer` L3 persona plugin (ADR-0042 PR1):
  dual host manifests, both marketplace catalog entries, release-please
  package wiring, and the staged plugin-shape test. Incubating scaffold —
  no functional command/skill surface ships in this release.
