---
description: Choose among candidate approaches, styles, or generated image variants under the brief — image's decision verb
argument-hint: (candidate styles/variants or natural-language choice)
---

# Image · Decide

$ARGUMENTS

Follow the decide skill at `$CLAUDE_PLUGIN_ROOT/skills/decide/SKILL.md`.

Chooses among candidate approaches, styles, or generated variants under
the brief's constraints. Variant selection marks `selected`/`rejected` in
the run manifest; rejected variants are retained as audit artifacts unless
explicitly cleaned (`docs/contracts.md` §7).

> **Lean L2 — no workflow state.** Selection is recorded in the run
> manifest (`docs/contracts.md` §4), not a durable workflow file.

> **Scaffold stub.** Full implementation lands in the `decide` verb PR.
