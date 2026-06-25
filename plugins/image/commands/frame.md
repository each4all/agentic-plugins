---
description: Turn an image request into an explicit image brief — subject, composition, style, palette, aspect ratio, output parameters, success criteria — image's framing verb
argument-hint: (natural-language image request)
---

# Image · Frame

$ARGUMENTS

Follow the frame skill at `$CLAUDE_PLUGIN_ROOT/skills/frame/SKILL.md`.

Produces an explicit `ImageBrief` (`docs/contracts.md` §3) that
`image:compose` renders into a prompt. Warn/reject brief fields gpt-image-2
cannot honor — e.g. a transparent background (`docs/contracts.md` §5);
never pretend prompt wording guarantees an unsupported parameter.

> **Lean L2 — no workflow state.** The brief is written as `brief.json`
> under the run dir (`docs/contracts.md`), not a durable workflow file.

**Validate before compose**: run the helper to check the brief's output
parameters against gpt-image-2 limits (size grid/aspect/total, quality, format,
variants, and the unsupported transparent background):

```bash
node "$CLAUDE_PLUGIN_ROOT/scripts/brief-validate.mjs" --brief-file <brief.json>
```

Surface issues; do NOT pass an invalid brief to compose. Write the brief as
`brief.json` — `image:compose` renders its subject/style into the prompt and
its output params into `--size`/`--quality`/`--format`.
