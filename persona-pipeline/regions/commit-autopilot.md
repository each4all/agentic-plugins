```bash
ROOT_OVERRIDE="$(printenv {{root_env}} || true)"
CLAUDE_PLUGIN_ROOT="${ROOT_OVERRIDE:-${CLAUDE_PLUGIN_ROOT}}"
[ -n "$CLAUDE_PLUGIN_ROOT" ] || CLAUDE_PLUGIN_ROOT="$(find ~/.claude/plugins/cache/agentic-plugins/{{name}} -mindepth 1 -maxdepth 1 -type d 2>/dev/null | grep -E '/(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$' | sort -V | tail -1)"
PERSONA={{name}}
REPO_ROOT="$(git rev-parse --show-toplevel)" || exit 1
ACTIVE="$(node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" find-active --repo-root "$REPO_ROOT")" || exit $?
[ -n "$ACTIVE" ] || { echo "✗ No active ${PERSONA} workflow on this branch." >&2; exit 1; }
# Recovers an interrupted commit, closes a done workflow with nothing to
# commit, stops at the staging-set owner gate, or commits with plan mode's
# suggested subjects and --strict-cc. The owner gate is also where it stops
# when the workflow did not begin on a clean tree or the index is pre-staged:
# only the owner can tell pre-existing hunks from the workflow's own. It takes
# no confirm or bypass flag and refuses outside an autopilot run, on a /start
# workflow, and while an owner gate or a peer ensemble is pending.
node "$CLAUDE_PLUGIN_ROOT/scripts/phase7-commit.mjs" --mode autopilot \
  --workflow-path "$ACTIVE" --repo-root "$REPO_ROOT" --host "${AGENTIC_HOST:-claude}"
```

Report its JSON `action` in the Completion below. Never push or open a pull
request afterwards: waiting for the landing is the owner's routine step, which
the driver reads from state, and it is not an owner gate.
