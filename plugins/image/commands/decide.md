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

Enumerate candidates (zero-based index + path + `manifest.cost`), then **select**
a generated variant by recording it in the run manifest:

```bash
node "$CLAUDE_PLUGIN_ROOT/scripts/variant-select.mjs" --manifest-file <run-dir>/manifest.json --select <index>
```

Rejected variants are kept as audit artifacts. Cleanup is explicit: **list the
exact rejected paths + confirm**, THEN prune (deletes only rejected non-selected
png/jpeg/webp variants whose real path is inside the run dir — never
`manifest.json`/`brief.json`):

```bash
node "$CLAUDE_PLUGIN_ROOT/scripts/variant-select.mjs" --manifest-file <...> --prune-rejected
```

Cleanup does not refund spend (`manifest.cost`). Do not regenerate to pick —
that's `image:refine` (`docs/contracts.md` §7).
