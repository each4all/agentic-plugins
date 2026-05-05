# Changelog

## [0.3.0](https://github.com/each4all/agentic-plugins/compare/companions-v0.2.0...companions-v0.3.0) (2026-05-05)


### ⚠ BREAKING CHANGES

* **companions+plugin/companions:** AGENTIC_COMPANIONS_ROOT must point to a directory containing discover-peer.mjs in addition to the script pair. The canonical source-tree companions/ directory ships all three files and continues to work as the documented dev/CI override target. Custom override directories that include only the script pair must add a copy of discover-peer.mjs.

### Features

* **companions+plugin/companions:** extract canonical discovery library (Deliverable B) ([#25](https://github.com/each4all/agentic-plugins/issues/25)) ([a0e8f6a](https://github.com/each4all/agentic-plugins/commit/a0e8f6a2d32e5fe741ea4965b01dac0620dd90b7))

## [0.2.0](https://github.com/each4all/agentic-plugins/compare/companions-v0.1.2...companions-v0.2.0) (2026-05-05)


### Features

* **companions:** add claude-companion.mjs (Codex → Claude bridge) ([#2](https://github.com/each4all/agentic-plugins/issues/2)) ([5d01e6a](https://github.com/each4all/agentic-plugins/commit/5d01e6a5113b13546cc2401e1b026652fef86162))
* **companions:** add codex-companion.mjs (Claude → Codex bridge) ([#3](https://github.com/each4all/agentic-plugins/issues/3)) ([e798433](https://github.com/each4all/agentic-plugins/commit/e7984338b2536c0e18363c10eb59a48babd1cb22))
* **companions:** add contract.md draft (Stage 1 wire spec) ([#1](https://github.com/each4all/agentic-plugins/issues/1)) ([26a0695](https://github.com/each4all/agentic-plugins/commit/26a06958ff8ee99303e814147618a4008c110fdb))
* **plugin/research:** first reference plugin (Stage 1 exit, Claude direction) ([#17](https://github.com/each4all/agentic-plugins/issues/17)) ([f1c398f](https://github.com/each4all/agentic-plugins/commit/f1c398fb7873b04b18d4424882314cb9fce83269))


### Bug Fixes

* **companions:** extend AUTH_REGEX for Claude Code CLI 2.1.128 wording (companions v0.1.2) ([#20](https://github.com/each4all/agentic-plugins/issues/20)) ([376a3fd](https://github.com/each4all/agentic-plugins/commit/376a3fda687a60116f9b48dac5199d3a3f1a5def))

## 0.1.0 (2026-05-03)


### Features

* **companions:** add claude-companion.mjs (Codex → Claude bridge) ([#2](https://github.com/each4all/agentic-plugins/issues/2)) ([5d01e6a](https://github.com/each4all/agentic-plugins/commit/5d01e6a5113b13546cc2401e1b026652fef86162))
* **companions:** add codex-companion.mjs (Claude → Codex bridge) ([#3](https://github.com/each4all/agentic-plugins/issues/3)) ([e798433](https://github.com/each4all/agentic-plugins/commit/e7984338b2536c0e18363c10eb59a48babd1cb22))
* **companions:** add contract.md draft (Stage 1 wire spec) ([#1](https://github.com/each4all/agentic-plugins/issues/1)) ([26a0695](https://github.com/each4all/agentic-plugins/commit/26a06958ff8ee99303e814147618a4008c110fdb))
