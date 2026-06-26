---
description: Gather visual references, style exemplars, and brand/visual constraints for an image brief — image's evidence-gathering verb
argument-hint: (subject or visual-reference topic)
---

# Image · Investigate

$ARGUMENTS

Follow the investigate skill at `$CLAUDE_PLUGIN_ROOT/skills/investigate/SKILL.md`.

> **Lean L2 — no workflow state.** This command routes to the skill; the
> gathered references hand off as **text + source notes to `image:frame`** —
> NOT a run manifest (`manifest.json` is compose/refine's `ImageResult`,
> `docs/contracts.md` §4) and not durable workflow state.

**Privacy gate**: genericize any proprietary subject, brand, or reference
asset before web search or cross-host dispatch — only the genericized form
leaves the local host. The gate covers attached reference assets, not just
prompt text.

**Gather** via web search: style exemplars, palette references, composition
patterns, and any public brand/visual constraints — each cited. **Structure**
them into the ImageBrief fields (`docs/contracts.md` §3:
style/palette/composition/constraints), flagging anything gpt-image-2 cannot
honor (e.g. a transparent background). The references feed `image:frame`. No
image generation here — no generation cost.
