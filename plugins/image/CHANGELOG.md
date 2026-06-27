# Changelog — plugin-image

All notable changes to the `image` plugin are documented here.

## [0.2.0](https://github.com/each4all/agentic-plugins/compare/plugin-image-v0.1.0...plugin-image-v0.2.0) (2026-06-27)


### Features

* **plugin/image:** compose-core — generative core via codex-companion (ADR-0037) ([#440](https://github.com/each4all/agentic-plugins/issues/440)) ([ebbfca1](https://github.com/each4all/agentic-plugins/commit/ebbfca183cfff7993304e02d8c676cc2b3683136))
* **plugin/image:** critique-vision — vision evaluation via codex-companion (ADR-0037) ([#444](https://github.com/each4all/agentic-plugins/issues/444)) ([a7919b0](https://github.com/each4all/agentic-plugins/commit/a7919b08f80a836689929c0118f880fcff33e6af))
* **plugin/image:** decide — variant selection + safe retention (ADR-0037) ([#443](https://github.com/each4all/agentic-plugins/issues/443)) ([874ec80](https://github.com/each4all/agentic-plugins/commit/874ec809d306b4546a8e0fbd4e2a9d7024d51687))
* **plugin/image:** frame — ImageBrief schema + gpt-image-2 validation (ADR-0037) ([#441](https://github.com/each4all/agentic-plugins/issues/441)) ([356a609](https://github.com/each4all/agentic-plugins/commit/356a6098cc9915ce6ea77233126496ef5cf69106))
* **plugin/image:** investigate — visual reference gathering runbook (ADR-0037) ([#442](https://github.com/each4all/agentic-plugins/issues/442)) ([1ca3603](https://github.com/each4all/agentic-plugins/commit/1ca3603f15ff309d045a0b274f1bac9fba444f1c))
* **plugin/image:** refine-loop — feedback regeneration via compose reuse (ADR-0037) ([#445](https://github.com/each4all/agentic-plugins/issues/445)) ([0869b3a](https://github.com/each4all/agentic-plugins/commit/0869b3a0877fd264d02cd653e9d66252a81a243e))
* **plugin/image:** scaffold lean L2 image capability per ADR-0037 ([#438](https://github.com/each4all/agentic-plugins/issues/438)) ([81c724c](https://github.com/each4all/agentic-plugins/commit/81c724c8dd685b03a463206b659c7677bb60858e))

## 0.1.0 (initial scaffold seed)

- Scaffold for the `image` L2 capability plugin per ADR-0037.
- Dual-host manifests (`.claude-plugin/plugin.json` minimal,
  `.codex-plugin/plugin.json` full interface, **no hooks** — lean L2).
- Six cognitive verb surfaces (investigate / frame / decide / compose /
  critique / refine): command + SKILL + `agents/openai.yaml` stubs.
- Contract surfaces (`docs/contracts.md`): ImageBrief, ImageResult run
  manifest, gpt-image-2 parameter limits, prompt-rendered-parameter record,
  typed error taxonomy, artifact layout, retention policy, privacy gate.
- Registered in both marketplace catalogs + release-please wiring.
- Plugin-shape conformance test (lean shape, no-hooks assertion) + a
  direct-OpenAI-API-ban sentinel test.

> This entry records the seed; it does not imply a published tag.
