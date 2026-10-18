The read goes into a private directory of this resume's own, never a shared
`/tmp` name another session's resume could leave behind or overwrite; the
drift report and the marker (Phase 2b) read it from there. Before the block:

1. Create the directory, and note the path it prints:

   ```bash
   mktemp -d "${TMPDIR:-/tmp}/agentic-text.XXXXXX"
   ```

Then run the block with `READ_DIR` set to that directory. It prints the
workflow, its baseline and the checkout's current state. It first empties
`read.json`, so a run that stops (a failed lookup or read) leaves it empty,
never an earlier read, and the drift report and the marker refuse it.

```bash
READ_DIR='<directory from step 1>'
ROOT_OVERRIDE="$(printenv {{root_env}} || true)"
CLAUDE_PLUGIN_ROOT="${ROOT_OVERRIDE:-${CLAUDE_PLUGIN_ROOT}}"
[ -n "$CLAUDE_PLUGIN_ROOT" ] || CLAUDE_PLUGIN_ROOT="$(find ~/.claude/plugins/cache/agentic-plugins/{{name}} -mindepth 1 -maxdepth 1 -type d 2>/dev/null | grep -E '/(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$' | sort -V | tail -1)"
# A fresh shell: the workflow is found again here, never carried from an
# earlier block.
PERSONA={{name}}
# The last read is emptied before anything here can fail, so a retry that
# stops leaves no earlier snapshot behind (the readers refuse an empty
# read.json); nothing is removed. A READ_DIR left unfilled stops here (printf,
# not `:`, whose failed redirection would end a POSIX shell before the message).
printf '' 2>/dev/null >"$READ_DIR/read.json" || { echo "✗ READ_DIR ($READ_DIR) is not a directory this resume can write; set it to the directory step 1 created. Nothing was read." >&2; exit 1; }
REPO_ROOT="$(git rev-parse --show-toplevel)" || exit 1
ACTIVE="$(node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" find-active --repo-root "$REPO_ROOT")" || exit $?
[ -n "$ACTIVE" ] || { echo "✗ No active ${PERSONA} workflow on this branch." >&2; exit 1; }
# The read is checked on its own, and lands in read.json only whole.
node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" read --workflow-path "$ACTIVE" >"$READ_DIR/read.json.part" \
  || { echo "✗ state.mjs read failed for $ACTIVE (its error is above); no drift report." >&2; exit 1; }
mv -f "$READ_DIR/read.json.part" "$READ_DIR/read.json" || exit 1
CURRENT_BRANCH="$(git branch --show-current)"
CURRENT_HEAD="$(git rev-parse HEAD)"
CURRENT_DIGEST="$(git status --porcelain=v1 -z --untracked-files=normal | shasum -a 256 | cut -d' ' -f1)"
# A baseline field the workflow does not record reads empty; a read.json that
# does not parse stops the block.
BASE_BRANCH="$(node -e 'let r;try{r=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))}catch{process.exit(1)}process.stdout.write(String((r&&r.git_baseline||{})[process.argv[2]]??""))' "$READ_DIR/read.json" branch)" || { echo "✗ $READ_DIR/read.json is not the workflow read; no drift report." >&2; exit 1; }
BASE_HEAD="$(node -e 'let r;try{r=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))}catch{process.exit(1)}process.stdout.write(String((r&&r.git_baseline||{})[process.argv[2]]??""))' "$READ_DIR/read.json" head)" || { echo "✗ $READ_DIR/read.json is not the workflow read; no drift report." >&2; exit 1; }
BASE_DIGEST="$(node -e 'let r;try{r=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))}catch{process.exit(1)}process.stdout.write(String((r&&r.git_baseline||{})[process.argv[2]]??""))' "$READ_DIR/read.json" status_digest)" || { echo "✗ $READ_DIR/read.json is not the workflow read; no drift report." >&2; exit 1; }
printf 'workflow: %s\nbaseline: branch=%s head=%s status_digest=%s\ncurrent:  branch=%s head=%s status_digest=%s\n' \
  "$ACTIVE" "$BASE_BRANCH" "$BASE_HEAD" "$BASE_DIGEST" "$CURRENT_BRANCH" "$CURRENT_HEAD" "$CURRENT_DIGEST"
```
