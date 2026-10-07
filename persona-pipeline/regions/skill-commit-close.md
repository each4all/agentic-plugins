```bash
PERSONA={{name}}
REPO_ROOT="$(git rev-parse --show-toplevel)" || exit 1
ACTIVE="$(node "<plugin-root>/scripts/state.mjs" find-active --repo-root "$REPO_ROOT")" || exit $?
[ -n "$ACTIVE" ] || { echo "✗ No active ${PERSONA} workflow on this branch." >&2; exit 1; }
# Re-checks everything: git status clean (index, working tree, untracked),
# nothing committed since the workflow began, next_step_kind done, not a
# /start workflow, no owner gate or pending ensemble. Writes close-complete
# with the terminal marker, then archives the workflow (its HEAD never moved,
# so the Stop hook would not). A close stopped between the two is finished by
# running it again.
node "<plugin-root>/scripts/phase7-commit.mjs" --mode close \
  --workflow-path "$ACTIVE" --repo-root "$REPO_ROOT" --host <claude|codex>
```

It re-checks the close (`git status` clean, nothing committed,
`next_step_kind: done`, not a start workflow, no owner gate or pending
ensemble), writes `close-complete` with the terminal marker, and archives the
workflow: its HEAD never moved, so the Stop hook would not. It prints no
session-handoff footer, whose projection would read the unmoved HEAD as a
blocked archive. A close stopped between its two writes is finished by
running it again.
{{#capability dispatch_target}}
The Stop hook never notes a `close-complete` workflow on a parent macro,
because it made no commit. For a macro subtask its output names the next step,
`/orchestrator:done <subtask> --no-commit`, which needs a reason.
{{/capability}}
