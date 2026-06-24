---
description: Generate the image via Codex's integrated gpt-image — image's composition (generative) verb
argument-hint: (image brief or natural-language image description)
---

# Image · Compose

$ARGUMENTS

Follow the compose skill at `$CLAUDE_PLUGIN_ROOT/skills/compose/SKILL.md`.

Generation runs **only** through Codex's integrated gpt-image tool: native
`codex exec` on the Codex host, or the `codex-companion` bridge on the
Claude host. The generated image is written to the shared filesystem under
`.agentic-plugins/runs/image/<run-id>/` and returned **by path** (never
inlined). agentic-plugins never calls the OpenAI image API directly
(ADR-0037 Alternative 6).

> **Lean L2 — no workflow state.** `image` carries no workflow-continuity
> machinery; the brief/result flow through the run manifest
> (`docs/contracts.md` §4), not a durable workflow file.

**Privacy gate**: genericize the prompt before cross-host dispatch — only
the genericized form leaves the local host. Surface per-image cost; never
hide spend. Classify failures per the typed error taxonomy
(`docs/contracts.md` §8); no blind retry.

> **Scaffold stub.** The generative core + companion dispatch glue + the
> ADR-0037 item 3/7 non-bypass re-confirm land in the `compose-core` PR.
