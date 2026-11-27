Then commit.

An edited subject reaches the driver as a file, never in the block: in shell
source a quote, `$` or backtick of it would be read as code (ADR-0059,
amendment of 2026-10-10). When the user edited a subject or a body:

1. Create a private directory for them, and note the path it prints:

   ```bash
   # Step 1: a private text directory, marked so that the step that reads it
   # last releases it (ADR-0059 Decisions 9 and 10).
   MAKE_KIND='text'
   MAKE_PARENT=''
   {{> tmpdir-make-skill}}
   printf '%s\n' "$MADE_DIR"
   ```

2. With your file-writing tool, not the shell, write each edited subject
   there, one line ending with one newline: `subject.txt`, or
   `subject-<n>.txt` per commit of a split.

Then run the block with `TEXT_DIR` set to that directory, or empty when the
user accepted every suggestion and none was made. Once the driver succeeds the
block releases it (ADR-0059 Decision 10); a failure keeps it for the rerun.

```bash
TEXT_DIR='<the directory the edited subjects are in; empty when every suggestion was accepted>'
case "$TEXT_DIR" in
  *'<'*) echo "✗ TEXT_DIR is not set to the directory the edited subjects are in (empty when every suggestion was accepted); nothing was committed." >&2; exit 1 ;;
esac
PERSONA={{name}}
REPO_ROOT="$(git rev-parse --show-toplevel)" || exit 1
ACTIVE="$(node "<plugin-root>/scripts/state.mjs" find-active --repo-root "$REPO_ROOT")" || exit $?
[ -n "$ACTIVE" ] || { echo "✗ No active ${PERSONA} workflow on this branch." >&2; exit 1; }
# Subjects, one of:
#   --suggested-subjects                   the user accepted every suggestion (single or split);
#   --subject-file "$TEXT_DIR/subject.txt"
#                                          one commit, edited;
#   --subject-pkg-file '<package>'="$TEXT_DIR/subject-<n>.txt"
#                                          repeated, one per commit of a split
#                                          (the docs commit's key is `docs`).
# Bodies, only when the user edited the composed one (written as subjects are):
#   --body-file "$TEXT_DIR/body.txt"       one commit;
#   --body-pkg-file '<package>'="$TEXT_DIR/body-<n>.txt"
#                                          repeated, one per commit of a split.
# Staging, only when the plan had ask_user=true and the user confirmed the set:
#   --confirm-non-interactive, plus --include-extra <path> per extra they opted
#   in, or --accept-current-tree to take every change.
# A recovery (no_changes.path=recovery) needs no subject flag.
node "<plugin-root>/scripts/phase7-commit.mjs" --mode execute \
  --workflow-path "$ACTIVE" --repo-root "$REPO_ROOT" --host <claude|codex> \
  --suggested-subjects || exit $?
# ADR-0059 Decision 10, item 1 — the driver succeeded: no block, rerun or
# continuation reads the subjects again (nothing when TEXT_DIR is empty).
RELEASE_PATH="$TEXT_DIR"
{{> tmpdir-release-skill}}
```

- Subject flags: `--suggested-subjects` when the user accepted every
  suggestion; otherwise `--subject-file "$TEXT_DIR/subject.txt"` for one
  commit, or `--subject-pkg-file '<package>'="$TEXT_DIR/subject-<n>.txt"`
  once per commit of a split (the docs commit's key is `docs`), each file
  written as above. A recovery needs none.
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
