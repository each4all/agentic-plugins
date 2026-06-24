# Changelog — plugin-image

All notable changes to the `image` plugin are documented here.

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
