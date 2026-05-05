---
description: Adversarial audit of an entire area or codebase — sugar alias for /engineer:critique --profile=full-codebase
argument-hint: [--profile=full-codebase[:security|performance|code-quality|debt|full]] (sub-focus optional)
---

# Engineer · Audit (sugar alias)

$ARGUMENTS

`/engineer:audit` is a verb-level sugar alias per ADR-0010 §3 that
expands to `/engineer:critique --profile=full-codebase` (with optional
sub-focus appended after the colon). The canonical command is
`/engineer:critique`; this alias exists because "audit" is a familiar
trigger for whole-area review across teams transitioning from
omcc-dev's `audit` slash command.

**Behavior**: identical to `/engineer:critique` with profile forced to
`full-codebase`. The skill, ensemble dispatch (Adversarial-scan point
type per `skills/_shared/references/ensemble-protocol.md`), state
writes, and completion shape are all delegated to
`commands/critique.md` semantics.

---

## How to invoke

The user's `/engineer:audit` invocation maps to:

```
/engineer:critique --profile=full-codebase[<sub-profile>]
```

If `$ARGUMENTS` parses out a sub-focus token (e.g.,
`security`, `performance`, `code-quality`, `debt`, `full`), append it
after the colon: `--profile=full-codebase:security`. Default sub-focus
is `full` when none is provided.

---

## Execution — follow commands/critique.md

This alias does not duplicate the Phase 0/1/2 logic. Read and execute
`$CLAUDE_PLUGIN_ROOT/commands/critique.md` with `--profile=full-codebase[:<sub>]`
as the active profile. State writes use `verb=critique` (not "audit")
in the workflow file's `verb` field — the workflow_id and frontmatter
record the canonical verb, since the file name is immutable per
ADR-0011 §5 (the file name preserves origin verb; the active verb is
read from the frontmatter `verb` field).

If you bootstrapped via `/engineer:audit`, the workflow_id will start
with `critique-...` (NOT `audit-...`), because Phase 0's
`state.mjs create` is invoked with `--verb critique`. This is
intentional — sugar aliases canonicalize before any state mutation
per ADR-0010 §3.

---

## Completion

Same shape as `/engineer:critique`:

- `✓ Audit complete.` + count by severity. Recommend
  `/engineer:refine` to address selected CRITICAL + MAJOR findings.
- `✓ Audit complete (no significant findings).` — when no CRITICAL
  or MAJOR surfaced.

Workflow path is the canonical critique workflow file.
