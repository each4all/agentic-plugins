---
name: frame
description: "Turns an image request into an explicit image brief — subject, composition, style, palette, aspect ratio, output parameters (size/quality/format/variant count), and success criteria. The image plugin's framing verb. Use after a request to crystallize the brief before generating. Trigger phrases include 'frame the image', 'define the image', 'image brief', 'what should the image look like', 'spec the picture', '이미지 브리프', '이미지 정의', '그림 사양'."
---

# Frame (image capability)

The image plugin's framing verb (ADR-0010 §2, ADR-0037 Decision 1). Turns a
request into an explicit `ImageBrief` (`docs/contracts.md` §3) that
`image:compose` renders into a prompt + parameters.

## ImageBrief

Capture: `subject`, `composition`, `style`, `palette`, `aspect_ratio`,
`output` { `size`, `quality`, `format`, `variants` }, `success_criteria`
(used later by `image:critique`), and `constraints`.

Reflect compose-core's measured findings (`docs/parameter-probe.md`): size and
format are honored prompt-mediated; quality is best-effort; Codex surfaces only
the prompt (`docs/contracts.md` §5).

## Validate against gpt-image-2 limits

Before the brief reaches compose, validate its output parameters with the
helper:

```bash
node "$CLAUDE_PLUGIN_ROOT/scripts/brief-validate.mjs" --brief-file <brief.json>
```

It flags:

- **size** not `WxH`, off-grid (edges must be multiples of 16), max edge
  > 3840, aspect > 3:1, or total pixels outside 655,360..8,294,400
- bad **quality** (`low|medium|high|auto`) / **format** (`png|jpeg|webp`) /
  **variants** (integer >= 1)
- a **transparent-background** request — gpt-image-2 does NOT support it
  (reject; never promise it through prompt wording, `docs/contracts.md` §5)

Surface any issues to the user; do NOT pass an invalid brief to compose.
Multi-variant briefs warn on cost (`docs/contracts.md` §7).

## Hand-off to compose

Write the brief as `brief.json`; `image:compose` renders its subject/style into
the prompt and its `output` params into `--size` / `--quality` / `--format`.
Lean L2: the brief is a file, not durable workflow state.
