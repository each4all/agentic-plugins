```bash
ROOT_OVERRIDE="$(printenv {{root_env}} || true)"
CLAUDE_PLUGIN_ROOT="${ROOT_OVERRIDE:-${CLAUDE_PLUGIN_ROOT}}"
[ -n "$CLAUDE_PLUGIN_ROOT" ] || CLAUDE_PLUGIN_ROOT="$(find ~/.claude/plugins/cache/agentic-plugins/{{name}} -mindepth 1 -maxdepth 1 -type d 2>/dev/null | grep -E '/(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$' | sort -V | tail -1)"
PERSONA={{name}}
REPO_ROOT="$(git rev-parse --show-toplevel)" || exit 1
ACTIVE="$(node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" find-active --repo-root "$REPO_ROOT")" || exit $?
[ -n "$ACTIVE" ] || { echo "✗ No active ${PERSONA} workflow on this branch." >&2; exit 1; }
node "$CLAUDE_PLUGIN_ROOT/scripts/phase7-commit.mjs" --mode plan \
  --workflow-path "$ACTIVE" --repo-root "$REPO_ROOT" --host "${AGENTIC_HOST:-claude}"
```

Read the plan JSON and follow `core/skills/commit/SKILL.md` § Phase 1 — Plan:

- `branch: no-changes` → `no_changes.path` decides:
  - `recovery` → an earlier run's commits landed but its terminal write did
    not. Phase 2 finishes it (no subject needed).
  - `close` → the last verb recorded that the work needs no commit, and
    nothing was committed. Confirm with the user ("Recommended: close without
    a commit. Proceed?"), then Phase 3.
  - `blocked` → report `no_changes.reason` and stop; nothing is written.
- Otherwise present the staging set and `commits[].suggested_subject`, with
  `ask_user`, `extras` and `requires_split`, exactly as `/{{persona}}:start`
  Phase 7 does, and get the user's accept / edit / cancel.
