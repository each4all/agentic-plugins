---
description: Apply critique or feedback and regenerate the image — image's refinement verb
argument-hint: (feedback to apply, or natural-language refinement)
---

# Image · Refine

$ARGUMENTS

Follow the refine skill at `$CLAUDE_PLUGIN_ROOT/skills/refine/SKILL.md`.

Applies critique/feedback and regenerates through Codex's integrated
gpt-image (the same dispatch path as `image:compose`). Each regeneration
is a new spending loop: disclose per-iteration cost + a cap; no automatic
retry of user or moderation errors (`docs/contracts.md` §8).

> **Lean L2 — no workflow state.** Iterations append to the run manifest
> (`docs/contracts.md` §4), not a durable workflow file.

**Privacy gate**: genericize the revised prompt before cross-host dispatch.

> **Scaffold stub.** Full implementation lands in the `refine-loop` PR.
