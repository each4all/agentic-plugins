Then:

```bash
PERSONA={{name}}
REPO_ROOT="$(git rev-parse --show-toplevel)" || exit 1
ACTIVE="$(node "<plugin-root>/scripts/state.mjs" find-active --repo-root "$REPO_ROOT")" || exit $?
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
node "<plugin-root>/scripts/phase7-commit.mjs" --mode execute \
  --workflow-path "$ACTIVE" --repo-root "$REPO_ROOT" --host <claude|codex> \
  --suggested-subjects
```

- Subject flags: `--suggested-subjects` when the user accepted every
  suggestion; otherwise `--subject '<text>'` for one commit, or
  `--subject-pkg '<package>=<text>'` once per commit of a split (the docs
  commit's key is `docs`). A recovery needs none.
- Staging flags, only when the plan had `ask_user: true` and the user
  confirmed: `--confirm-non-interactive`, plus `--include-extra <path>` per
  opted-in extra or `--accept-current-tree`.

Before the first commit the driver takes the workflow out of its terminal
state (`phase-7-commit`, no marker), so a split that fails halfway is never
archived by a Stop hook that sees HEAD moved. On success it has
{{#capability dispatch_target}}
sent the parent note and
{{/capability}}
written `set-terminal commit-complete` last. On failure it printed what
landed and what did not; the workflow stays active, and running this skill
again resumes: a rerun plans only what is left, and a clean tree whose
commits all landed is the `recovery` path.

ARCHIVE TIMING — decide before running execute. On Claude the Stop hook fires
at **every turn end**, so a successful commit's terminal write is evaluated
by the archive gates at the end of that turn, not at session close. Clearing
the marker with `--terminal-marker false` works only before that Stop fires
and needs set-terminal's full flag set. On Codex the Stop hook runs only once
the operator has trusted the plugin hooks (`/hooks`); until then archive the
committed workflow with `${{persona}}:resume`. The close path archives the
workflow itself. Full contract:
`../_shared/references/session-handoff.md` § Archive timing.
