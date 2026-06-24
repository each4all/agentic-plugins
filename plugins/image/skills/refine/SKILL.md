---
name: refine
description: "Applies critique findings or feedback and regenerates the image — the image plugin's refinement verb. Use after a critique to iterate on a generated image. Each regeneration is a new spending loop with explicit cost disclosure. Trigger phrases include 'refine the image', 'regenerate with changes', 'apply the feedback', 'fix the image', 'iterate on this', '이미지 보완', '다시 생성', '피드백 반영', '수정해서 다시'."
---

# Refine (image capability)

The image plugin's refinement verb (ADR-0010 §2, ADR-0037 Decision 1).
Applies critique/feedback and regenerates through Codex's integrated
gpt-image (the same dispatch path as `image:compose`).

Each regeneration is a **new spending loop**: explicit per-iteration cost
disclosure + a cap, and no automatic retry of user/moderation errors
(`docs/contracts.md` §8). The privacy gate genericizes the revised prompt
before dispatch (`docs/contracts.md` §9).

> **Scaffold stub.** Full implementation lands in the `refine-loop` PR.
> This scaffold establishes the verb surface + contract.
