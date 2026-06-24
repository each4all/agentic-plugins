---
description: Gather visual references, style exemplars, and brand/visual constraints for an image brief — image's evidence-gathering verb
argument-hint: (subject or visual-reference topic)
---

# Image · Investigate

$ARGUMENTS

Follow the investigate skill at `$CLAUDE_PLUGIN_ROOT/skills/investigate/SKILL.md`.

> **Lean L2 — no workflow state.** This command routes to the skill; the
> gathered references feed the brief through a run manifest under
> `.agentic-plugins/runs/image/` (`docs/contracts.md`), not a durable
> workflow file.

**Privacy gate**: genericize any proprietary subject, brand, or reference
asset before web search or cross-host dispatch — only the genericized form
leaves the local host. The gate covers attached reference assets, not just
prompt text.

> **Scaffold stub.** Full implementation lands in the `investigate` verb PR.
