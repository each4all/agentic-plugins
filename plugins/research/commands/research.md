---
description: Research a topic — produce a durable cited research brief
argument-hint: Research topic or question
---

# Research

$ARGUMENTS

Use `TaskCreate` and `TaskUpdate` to track progress.

Follow the research skill's command-invoked mode
(`skills/research/SKILL.md`). The skill handles topic intake, research
execution, synthesis, and output assembly per its referenced specs.

The bidirectional research-scan ensemble runs automatically per
`skills/research/references/ensemble-protocol.md` when the companions
plugin is installed and the peer-host CLI (Codex) is available — never
ask the user whether to invoke the peer, and never direct them to run
peer-CLI commands manually. When the companions plugin or the peer
CLI is unavailable, the ensemble degrades silently to local-only and
the brief is produced normally.

---

## Completion

Output depends on whether the brief was actually written and whether
the abort came at scoping (before research) or at save (after research):

- **If saved** (overwrite or distinct-directory branch): "✓ Research
  brief saved." plus the saved file path under
  `<resolved-root>/YYYY-MM-DD_<topic-slug>/`. Offer to: adjust scope
  and re-run, deepen specific findings, or export to a different
  location.
- **If aborted at save** (Step 4 existing-directory abort branch —
  research ran, brief was synthesized, user declined to save): "ℹ Brief
  presented inline without saving (existing-directory abort)." No
  path. Offer to save under a distinct directory on user confirmation.
- **If aborted at scoping** (Step 1 existing-directory abort branch,
  command mode only — user declined before research ran): "ℹ Aborted
  at scoping (existing-directory abort); no research conducted, no
  brief produced." No path, no inline brief. Offer to retry with a
  distinct topic or to clean the existing directory and re-run.

Do NOT print the "✓ saved" message when no file was written.
