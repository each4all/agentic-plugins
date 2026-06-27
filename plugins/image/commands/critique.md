---
description: Evaluate a generated image against the brief using vision input — image's critique verb
argument-hint: (path to a generated image, or natural-language critique target)
---

# Image · Critique

$ARGUMENTS

Follow the critique skill at `$CLAUDE_PLUGIN_ROOT/skills/critique/SKILL.md`.

Evaluates a generated image against the brief's success criteria using
**vision**: Codex reads + visually inspects the image. `codex-companion` has no
`--image` flag — the helper passes the absolute image path in the prompt
(prompt-mediated vision, feasibility-confirmed):

```bash
node "$CLAUDE_PLUGIN_ROOT/scripts/critique-dispatch.mjs" \
  --image <absolute-path> --criteria-file <criteria.txt> --repo-root "$REPO_ROOT"
```

It verifies the file (refuses missing / symlink / non-image / empty / oversized)
and returns the per-criterion assessment + a verdict (pass/fail).

**Privacy gate**: the image path AND its visual contents leave the local host.
Genericize or gate non-public images before dispatch. On `peer_cli_not_found`,
report the honest-scope limit (no Codex bridge → no vision critique); do not
fake a verdict.

> **Lean L2 — no workflow state.** The assessment is text; a failing critique
> feeds `image:refine`.
