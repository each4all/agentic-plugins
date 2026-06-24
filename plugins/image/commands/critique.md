---
description: Evaluate a generated image against the brief using vision input — image's critique verb
argument-hint: (path to a generated image, or natural-language critique target)
---

# Image · Critique

$ARGUMENTS

Follow the critique skill at `$CLAUDE_PLUGIN_ROOT/skills/critique/SKILL.md`.

Evaluates a generated image against the brief's success criteria using
vision input — `codex exec --image <FILE>` attaches the generated file
back for evaluation (a clean compose/critique symmetry).

**Privacy gate**: attaching an image sends its content to Codex/OpenAI.
Genericize or gate non-public images before dispatch; handle missing,
oversized, or unsupported image files explicitly (`docs/contracts.md` §9).

> **Lean L2 — no workflow state.** The critique references the run manifest
> (`docs/contracts.md` §4), not a durable workflow file.

> **Scaffold stub.** Full implementation lands in the `critique-vision` PR.
