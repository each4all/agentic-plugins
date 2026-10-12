---
name: critique
description: "Evaluates a generated image against the brief's success criteria using vision input — the image plugin's critique verb. Codex reads and visually inspects the generated image (prompt-mediated; codex-companion has no --image flag). Use to review a generated image before accepting or refining it. Trigger phrases include 'review this image', 'evaluate the image', 'does this match the brief', 'critique the picture', 'is this good', '이미지 평가', '이 그림 어때', '브리프에 맞아'."
---

# Critique (image capability)

The image plugin's critique verb (ADR-0010 §2, ADR-0037 Decision 1). Evaluates a
generated image against the brief's `success_criteria` using **vision**: Codex
reads and visually inspects the image. `codex-companion` has no `--image` flag —
a feasibility run confirmed Codex sees a local image given its absolute path in
the prompt (**prompt-mediated vision**, simpler than the ADR's `codex exec
--image` assumption). The helper in step 2 handles it.

## When invoked

1. **Send disclosure** (`docs/contracts.md` §9): on the Claude host, tell the
   user first that the image and the criteria go to Codex (OpenAI), which
   reads the image by its path, runs in the repository and can read files
   there; ask no confirmation. The helper prints the same disclosure before
   it sends.

2. **Evaluate**: pass the generated image + the brief's `success_criteria`:

   ```bash
   node "$CLAUDE_PLUGIN_ROOT/scripts/critique-dispatch.mjs" \
     --image <absolute-path> --criteria-file <criteria.txt> --repo-root "$REPO_ROOT"
   ```

   The helper refuses missing / non-image / symlink / empty / oversized files
   before dispatch, then dispatches to Codex and returns the per-criterion
   assessment + a `verdict` (pass/fail), parsed best-effort from Codex's text.

3. **Honest scope**: if `codex-companion` is unreachable (`peer_cli_not_found`),
   report that Claude cannot run vision critique without the Codex bridge — do
   NOT fake a verdict.

4. **Hand-off**: a failing critique feeds `image:refine` (apply feedback +
   regenerate). Lean L2 — the assessment is text, not durable workflow state.
