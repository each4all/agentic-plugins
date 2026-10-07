```bash
ROOT_OVERRIDE="$(printenv {{root_env}} || true)"
CLAUDE_PLUGIN_ROOT="${ROOT_OVERRIDE:-${CLAUDE_PLUGIN_ROOT}}"
[ -n "$CLAUDE_PLUGIN_ROOT" ] || CLAUDE_PLUGIN_ROOT="$(find ~/.claude/plugins/cache/agentic-plugins/{{name}} -mindepth 1 -maxdepth 1 -type d 2>/dev/null | grep -E '/(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$' | sort -V | tail -1)"
PERSONA={{name}}
REPO_ROOT="$(git rev-parse --show-toplevel)" || exit 1
ACTIVE="$(node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" find-active --repo-root "$REPO_ROOT")" || exit $?
[ -n "$ACTIVE" ] || { echo "✗ No active ${PERSONA} workflow on this branch." >&2; exit 1; }
# Re-checks everything: git status clean (index, working tree, untracked),
# nothing committed since the workflow began, next_step_kind done, not a
# /start workflow, no owner gate or pending ensemble. Writes close-complete
# with the terminal marker, then archives the workflow (its HEAD never moved,
# so the Stop hook would not). A close stopped between the two is finished by
# running it again.
node "$CLAUDE_PLUGIN_ROOT/scripts/phase7-commit.mjs" --mode close \
  --workflow-path "$ACTIVE" --repo-root "$REPO_ROOT" --host "${AGENTIC_HOST:-claude}"
```
