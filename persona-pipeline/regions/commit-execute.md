Then commit with what the user confirmed:

```bash
ROOT_OVERRIDE="$(printenv {{root_env}} || true)"
CLAUDE_PLUGIN_ROOT="${ROOT_OVERRIDE:-${CLAUDE_PLUGIN_ROOT}}"
[ -n "$CLAUDE_PLUGIN_ROOT" ] || CLAUDE_PLUGIN_ROOT="$(find ~/.claude/plugins/cache/agentic-plugins/{{name}} -mindepth 1 -maxdepth 1 -type d 2>/dev/null | grep -E '/(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$' | sort -V | tail -1)"
PERSONA={{name}}
REPO_ROOT="$(git rev-parse --show-toplevel)" || exit 1
ACTIVE="$(node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" find-active --repo-root "$REPO_ROOT")" || exit $?
[ -n "$ACTIVE" ] || { echo "✗ No active ${PERSONA} workflow on this branch." >&2; exit 1; }
# Subjects, one of:
#   --suggested-subjects                   the user accepted every suggestion (single or split);
#   --subject '<confirmed subject>'        one commit, edited;
#   --subject-pkg '<package>=<subject>'    repeated, one per commit of a split
#                                          (the docs commit's key is `docs`).
# Staging, only when the plan had ask_user=true and the user confirmed the set:
#   --confirm-non-interactive, plus --include-extra <path> per extra they opted
#   in, or --accept-current-tree to take every change.
# A recovery (no_changes.path=recovery) needs no subject flag.
node "$CLAUDE_PLUGIN_ROOT/scripts/phase7-commit.mjs" --mode execute \
  --workflow-path "$ACTIVE" --repo-root "$REPO_ROOT" --host "${AGENTIC_HOST:-claude}" \
  --suggested-subjects
```

The driver takes the workflow out of its terminal state before the first
commit (`phase-7-commit`, no marker), so a split that fails halfway is never
archived by a Stop that sees HEAD moved. On success it has
{{#capability dispatch_target}}
already sent the parent note (P10) and
{{/capability}}
written `set-terminal commit-complete` last. On failure it printed what
landed and what did not; the workflow stays active, and rerunning
`/{{persona}}:commit` resumes from there.

ARCHIVE TIMING — decide before running execute. On Claude the Stop hook fires
at **every turn end**, so a successful commit's terminal write is evaluated
by the archive gates at the end of this turn, not at session close, and the
workflow is archived then when every gate passes. Clearing the marker with
`--terminal-marker false` works only before that Stop fires and needs
set-terminal's full flag set. On Codex the Stop hook runs only once the
operator has trusted the plugin hooks (`/hooks`), so the archive waits for
that. The close path archives the workflow itself. Full contract:
`core/skills/_shared/references/session-handoff.md` § Archive timing.
