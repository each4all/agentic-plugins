---
description: Evaluate a generated image against the brief using vision input — image's critique verb
argument-hint: (path to a generated image, or natural-language critique target)
---

# Image · Critique

$ARGUMENTS

Follow the critique skill at `${CLAUDE_PLUGIN_ROOT}/core/skills/critique/SKILL.md`.

Evaluates a generated image against the brief's success criteria using
**vision**: Codex reads + visually inspects the image.

**Send disclosure** (`docs/contracts.md` §9): first, tell the user that the
image and the criteria go to Codex (OpenAI), which reads the image by its
path, runs in the repository and can read files there; ask no confirmation.
The helper prints the same disclosure before it sends.

`codex-companion` has no `--image` flag — the helper passes the absolute image
path in the prompt (prompt-mediated vision, feasibility-confirmed):

```bash
CLAUDE_PLUGIN_ROOT="${AGENTIC_IMAGE_ROOT:-${CLAUDE_PLUGIN_ROOT}}"
[ -n "$CLAUDE_PLUGIN_ROOT" ] || CLAUDE_PLUGIN_ROOT="$(find ~/.claude/plugins/cache/agentic-plugins/image -mindepth 1 -maxdepth 1 -type d 2>/dev/null | grep -E '/(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$' | sort -V | tail -1)"
node "$CLAUDE_PLUGIN_ROOT/scripts/critique-dispatch.mjs" \
  --image <absolute-path> --criteria-file <criteria.txt> --repo-root "$REPO_ROOT"
```

It verifies the file (refuses missing / symlink / non-image / empty / oversized)
and returns the per-criterion assessment + a verdict (pass/fail).

On `peer_cli_not_found`, report the honest-scope limit (no Codex bridge → no
vision critique); do not fake a verdict.

> **Lean L2 — no workflow state.** The assessment is text; a failing critique
> feeds `image:refine`.
