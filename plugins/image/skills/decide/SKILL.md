---
name: decide
description: "Chooses among candidate approaches, styles, or generated image variants under the brief's constraints — the image plugin's decision verb. Use to pick a direction or select the best variant from a multi-image generation. Trigger phrases include 'which variant', 'pick the best image', 'choose a style', 'compare these images', 'which one', '어떤 변형', '어떤 이미지', '베스트 골라', '스타일 선택'."
---

# Decide (image capability)

The image plugin's decision verb (ADR-0010 §2, ADR-0037 Decision 1).
Chooses among candidate approaches, styles, or generated variants under
the brief's constraints — variant selection is core to quality-first
image work.

Records `selected`/`rejected` in the `ImageResult` run manifest
(`docs/contracts.md` §4). Rejected variants are retained as audit
artifacts by default; cleanup is explicit, never automatic
(`docs/contracts.md` §7).

> **Scaffold stub.** Full implementation lands in the `decide` verb PR.
> This scaffold establishes the verb surface + contract.
