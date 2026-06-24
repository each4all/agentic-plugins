---
name: critique
description: "Evaluates a generated image against the brief's success criteria using vision input — the image plugin's critique verb. Codex exec --image attaches the generated file back for evaluation (compose/critique symmetry). Use to review a generated image before accepting or refining it. Trigger phrases include 'review this image', 'evaluate the image', 'does this match the brief', 'critique the picture', 'is this good', '이미지 평가', '이 그림 어때', '브리프에 맞아'."
---

# Critique (image capability)

The image plugin's critique verb (ADR-0010 §2, ADR-0037 Decision 1).
Evaluates a generated image against the brief's success criteria using
**vision input**: `codex exec --image <FILE>` attaches the generated file
back — a clean compose/critique symmetry.

The privacy gate (`docs/contracts.md` §9) applies to the attached image:
genericize or gate non-public images before dispatch; handle missing,
oversized, or unsupported files explicitly.

> **Scaffold stub.** Full implementation lands in the `critique-vision` PR.
> This scaffold establishes the verb surface + contract.
