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

> **Scaffold stub.** Full implementation lands in the `frame` verb PR.
