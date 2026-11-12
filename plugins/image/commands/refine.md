---
description: Apply critique or feedback and regenerate the image — image's refinement verb
argument-hint: (feedback to apply, or natural-language refinement)
---

# Image · Refine

$ARGUMENTS

Follow the refine skill at `${CLAUDE_PLUGIN_ROOT}/core/skills/refine/SKILL.md`.

Applies critique/feedback and regenerates through Codex's integrated
gpt-image (the same dispatch path as `image:compose`). Each regeneration
is a new spending loop: disclose per-iteration cost + a cap; no automatic
retry of user or moderation errors (`docs/contracts.md` §8).

> **Lean L2 — no workflow state.** Iterations append to the run manifest
> (`docs/contracts.md` §4), not a durable workflow file.

**Quality tier**: keep the tier the image was made at — the brief's
`output.quality` or the identified previous run's
`requested_parameters.quality` (`docs/contracts.md` §3, §4). When the two
differ, or neither names one, propose a tier and ask before generating; pass
it as `--quality <tier>` on every call (the skill's step 0).

**Cost gate**: each refine is a NEW generation — disclose cost, and the tier
it priced, before regenerating (`--estimate-only --quality <tier>` computes it
without spending; `cost.tier_assumed: true` means no known tier was passed and
`medium` was priced),
and with it that the base prompt and the feedback go to Codex (OpenAI),
which runs in the repository and can read files there (`docs/contracts.md`
§9); ask no confirmation. The helper prints the same disclosure before it
sends. HARD iteration cap (default 3,
caller cannot raise — `--max-iterations` is clamped); no auto-retry of
user/moderation errors. Regenerate with the feedback applied (reuses
compose-dispatch):

```bash
CLAUDE_PLUGIN_ROOT="${AGENTIC_IMAGE_ROOT:-${CLAUDE_PLUGIN_ROOT}}"
[ -n "$CLAUDE_PLUGIN_ROOT" ] || CLAUDE_PLUGIN_ROOT="$(find ~/.claude/plugins/cache/agentic-plugins/image -mindepth 1 -maxdepth 1 -type d 2>/dev/null | grep -E '/(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$' | sort -V | tail -1)"
node "$CLAUDE_PLUGIN_ROOT/scripts/refine-dispatch.mjs" --base-prompt-file <base.txt> --feedback-file <feedback.txt> --iteration <N> --max-iterations 3 --repo-root "$REPO_ROOT" --format png --quality <tier> [--background opaque|auto|transparent]
```

Renders base + feedback into a new generation (new run-id manifest, cost
surfaced). Past the cap it returns `iteration_cap` (no generation).
