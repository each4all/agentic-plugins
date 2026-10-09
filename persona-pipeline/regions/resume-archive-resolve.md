```bash
ROOT_OVERRIDE="$(printenv {{root_env}} || true)"
CLAUDE_PLUGIN_ROOT="${ROOT_OVERRIDE:-${CLAUDE_PLUGIN_ROOT}}"
[ -n "$CLAUDE_PLUGIN_ROOT" ] || CLAUDE_PLUGIN_ROOT="$(find ~/.claude/plugins/cache/agentic-plugins/{{name}} -mindepth 1 -maxdepth 1 -type d 2>/dev/null | grep -E '/(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$' | sort -V | tail -1)"
REPO_ROOT="$(git rev-parse --show-toplevel)" || exit 1
ARCHIVE_WORKFLOW_ID='<workflow-id>'
if ! WORKFLOW="$(node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" \
    resolve-workflow --repo-root "$REPO_ROOT" --workflow-id "$ARCHIVE_WORKFLOW_ID")"; then
  echo "✗ $ARCHIVE_WORKFLOW_ID names no single workflow file in the workflow homes of this checkout's read set (the reason is above); nothing archived." >&2
  exit 1
fi
printf 'WORKFLOW=%s\n' "$WORKFLOW"
```
