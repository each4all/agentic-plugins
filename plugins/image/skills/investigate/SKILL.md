---
name: investigate
description: "Gathers visual references, style exemplars, and brand/visual constraints — image's evidence-gathering verb. Use before framing an image brief to collect reference material, art-direction exemplars, and visual constraints. Trigger phrases include 'find references for', 'visual references', 'style examples', 'mood board', 'what style', 'look for inspiration', '레퍼런스 찾아', '스타일 예시', '비주얼 참고'."
---

# Investigate (image capability)

The image plugin's evidence-gathering verb (ADR-0010 §2, ADR-0037
Decision 1). Gathers visual references, style exemplars, and brand/visual
constraints that feed the `ImageBrief` (`docs/contracts.md` §3).

The privacy gate (`docs/contracts.md` §9) covers web/reference
investigation AND attached reference assets — only genericized material
leaves the local host.

> **Scaffold stub.** Full implementation lands in the `investigate` verb
> PR. This scaffold establishes the verb surface + contract.
