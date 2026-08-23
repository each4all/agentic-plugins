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

**Cost gate**: each refine is a NEW generation — disclose cost before
regenerating (`--estimate-only --quality <q>` computes it without spending);
HARD iteration cap (default 3, caller cannot raise — `--max-iterations` is
clamped); no auto-retry of user/moderation errors. Regenerate with the feedback
applied (reuses compose-dispatch):

```bash
node "$CLAUDE_PLUGIN_ROOT/scripts/refine-dispatch.mjs" --base-prompt-file <base.txt> --feedback-file <feedback.txt> --iteration <N> --max-iterations 3 --repo-root "$REPO_ROOT" --format png --quality low [--background opaque|auto|transparent]
```

Renders base + feedback into a new generation (new run-id manifest, cost
surfaced). Past the cap it returns `iteration_cap` (no generation). Genericize
the prompt before dispatch (`docs/contracts.md` §9).
