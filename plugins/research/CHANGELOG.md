# Changelog

## [0.3.1](https://github.com/each4all/agentic-plugins/compare/plugin-research-v0.3.0...plugin-research-v0.3.1) (2026-05-05)


### Bug Fixes

* **release-please:** correct extra-files path scope (package-relative + root-absolute) ([#28](https://github.com/each4all/agentic-plugins/issues/28)) ([117d737](https://github.com/each4all/agentic-plugins/commit/117d7379417401db3707c8e8bc75bfc58d868fcc))

## [0.3.0](https://github.com/each4all/agentic-plugins/compare/plugin-research-v0.2.0...plugin-research-v0.3.0) (2026-05-05)


### ⚠ BREAKING CHANGES

* **companions+plugin/companions:** AGENTIC_COMPANIONS_ROOT must point to a directory containing discover-peer.mjs in addition to the script pair. The canonical source-tree companions/ directory ships all three files and continues to work as the documented dev/CI override target. Custom override directories that include only the script pair must add a copy of discover-peer.mjs.

### Features

* **companions+plugin/companions:** extract canonical discovery library (Deliverable B) ([#25](https://github.com/each4all/agentic-plugins/issues/25)) ([a0e8f6a](https://github.com/each4all/agentic-plugins/commit/a0e8f6a2d32e5fe741ea4965b01dac0620dd90b7))

## [0.2.0](https://github.com/each4all/agentic-plugins/compare/plugin-research-v0.1.0...plugin-research-v0.2.0) (2026-05-05)


### Features

* **plugin/research:** first reference plugin (Stage 1 exit, Claude direction) ([#17](https://github.com/each4all/agentic-plugins/issues/17)) ([f1c398f](https://github.com/each4all/agentic-plugins/commit/f1c398fb7873b04b18d4424882314cb9fce83269))


### Bug Fixes

* **plugin/research:** wrap agents/openai.yaml fields in interface: block per Codex skill schema ([#19](https://github.com/each4all/agentic-plugins/issues/19)) ([9ef8c7d](https://github.com/each4all/agentic-plugins/commit/9ef8c7d2ff16155c26382867f8ef7835001c2867))
