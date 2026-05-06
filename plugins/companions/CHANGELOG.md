# Changelog

## [0.4.0](https://github.com/each4all/agentic-plugins/compare/plugin-companions-v0.3.1...plugin-companions-v0.4.0) (2026-05-06)


### ⚠ BREAKING CHANGES

* **plugin/research:** plugins/research is removed. Any consumer that had the plugin installed must migrate to engineer:investigate cited-brief profile. /research:research command is no longer available; equivalent flow is /engineer:investigate --profile=cited-brief <topic> (or natural language with cited-brief trigger phrases for auto-mode). research_brief.md artifacts saved under the previous plugin remain readable.

### Miscellaneous Chores

* **plugin/research:** archive at Stage 2.5+ (timeline collapse per ADR-0014 Amendment) ([28b5eb8](https://github.com/each4all/agentic-plugins/commit/28b5eb80b7fb2a2b742032ac1090b3c4a21e12cd))

## [0.3.1](https://github.com/each4all/agentic-plugins/compare/plugin-companions-v0.3.0...plugin-companions-v0.3.1) (2026-05-05)


### Bug Fixes

* **release-please:** correct extra-files path scope (package-relative + root-absolute) ([#28](https://github.com/each4all/agentic-plugins/issues/28)) ([117d737](https://github.com/each4all/agentic-plugins/commit/117d7379417401db3707c8e8bc75bfc58d868fcc))

## [0.3.0](https://github.com/each4all/agentic-plugins/compare/plugin-companions-v0.2.0...plugin-companions-v0.3.0) (2026-05-05)


### ⚠ BREAKING CHANGES

* **companions+plugin/companions:** AGENTIC_COMPANIONS_ROOT must point to a directory containing discover-peer.mjs in addition to the script pair. The canonical source-tree companions/ directory ships all three files and continues to work as the documented dev/CI override target. Custom override directories that include only the script pair must add a copy of discover-peer.mjs.

### Features

* **companions+plugin/companions:** extract canonical discovery library (Deliverable B) ([#25](https://github.com/each4all/agentic-plugins/issues/25)) ([a0e8f6a](https://github.com/each4all/agentic-plugins/commit/a0e8f6a2d32e5fe741ea4965b01dac0620dd90b7))

## [0.2.0](https://github.com/each4all/agentic-plugins/compare/plugin-companions-v0.1.2...plugin-companions-v0.2.0) (2026-05-05)


### Features

* **plugin/companions:** wrap canonical companions as installable plugin ([#9](https://github.com/each4all/agentic-plugins/issues/9)) ([56ae15c](https://github.com/each4all/agentic-plugins/commit/56ae15cd6df895c9a83a5baf5cd99fd9f7e5100c))
* **plugin/research:** first reference plugin (Stage 1 exit, Claude direction) ([#17](https://github.com/each4all/agentic-plugins/issues/17)) ([f1c398f](https://github.com/each4all/agentic-plugins/commit/f1c398fb7873b04b18d4424882314cb9fce83269))


### Bug Fixes

* **companions:** extend AUTH_REGEX for Claude Code CLI 2.1.128 wording (companions v0.1.2) ([#20](https://github.com/each4all/agentic-plugins/issues/20)) ([376a3fd](https://github.com/each4all/agentic-plugins/commit/376a3fda687a60116f9b48dac5199d3a3f1a5def))

## 0.1.0 (2026-05-03)


### Features

* **plugin/companions:** wrap canonical companions as installable plugin ([#9](https://github.com/each4all/agentic-plugins/issues/9)) ([56ae15c](https://github.com/each4all/agentic-plugins/commit/56ae15cd6df895c9a83a5baf5cd99fd9f7e5100c))
