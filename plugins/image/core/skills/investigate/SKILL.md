---
name: investigate
description: "Gathers visual references, style exemplars, and brand/visual constraints — image's evidence-gathering verb. Use before framing an image brief to collect reference material, art-direction exemplars, and visual constraints. Trigger phrases include 'find references for', 'visual references', 'style examples', 'mood board', 'what style', 'look for inspiration', '레퍼런스 찾아', '스타일 예시', '비주얼 참고'."
---

# Investigate (image capability)

The image plugin's evidence-gathering verb (ADR-0010 §2, ADR-0037 Decision 1).
Gathers visual references, style exemplars, and brand/visual constraints that
feed the `ImageBrief` (`docs/contracts.md` §3). No image generation here — no
generation cost.

## When invoked

1. **Privacy gate** (`docs/contracts.md` §9): genericize the subject/brand
   before any web search or cross-host dispatch. The gate covers **attached
   reference assets** too — never use a private image's **bytes, filename,
   metadata, or private asset URL** as a web-search input, never reverse-image
   -search or upload a private/unpublished asset, and never send proprietary
   brand material off-host. If a request needs references that cannot be
   genericized, gather only what the gate allows and state what was held back
   (honest scope).

2. **Gather** via web search (WebSearch / WebFetch), preferring authoritative
   sources:
   - **brand / visual constraints** — prefer official/public brand guidelines
     first
   - **style** exemplars — art direction, medium, rendering style (public
     sources)
   - **palette** references — colour, mood
   - **composition** patterns — framing, layout, focal point

   For each reference, note what the source actually supports (a style cue, a
   palette, a layout) so frame can turn it into a concrete field.

3. **Structure** the findings as **field proposals + separate source notes**.
   `ImageBrief` (`docs/contracts.md` §3) has no citation field — keep URLs and
   citations OUT of the prompt-rendered fields (`style`/`palette`/`composition`)
   and in a separate "sources" note. Flag anything the **Codex prompt path
   cannot surface** — reference images, masks, partial-image streaming, and
   exact structured controls ("unsupported through Codex / deferred",
   `docs/contracts.md` §5) — so frame/compose don't promise them. A
   transparent background is **not** in that set any more (ADR-0055): it is
   supported for png and verified in the returned pixels, so flag only the
   format pairing (jpeg/webp) rather than the request itself.

4. **Hand-off**: the field proposals + source notes feed `image:frame`, which
   crystallizes + validates the full brief (`scripts/brief-validate.mjs`). Lean
   L2 — references flow as **text** into the brief, not a run manifest and not
   durable workflow state.
