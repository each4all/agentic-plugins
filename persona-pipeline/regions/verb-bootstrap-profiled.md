In the block, replace the profile placeholder with the profile the arguments
name; `AGENTIC_PROFILE` takes its place when it is set.

The request reaches `state.mjs` as a file, never in the block: in shell
source a quote, `$`, backtick or line break of it would be read as code
(ADR-0059, amendment of 2026-10-10). Before the block:

1. Create a private directory for it, and note the path it prints:

   ```bash
   # Step 1: a private text directory, marked so that the step that reads it
   # last releases it (ADR-0059 Decisions 9 and 10).
   ROOT_OVERRIDE="$(printenv {{root_env}} || true)"
   CLAUDE_PLUGIN_ROOT="${ROOT_OVERRIDE:-${CLAUDE_PLUGIN_ROOT}}"
   [ -n "$CLAUDE_PLUGIN_ROOT" ] || CLAUDE_PLUGIN_ROOT="$(find ~/.claude/plugins/cache/agentic-plugins/{{name}} -mindepth 1 -maxdepth 1 -type d 2>/dev/null | grep -E '/(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$' | sort -V | tail -1)"
   MAKE_KIND='text'
   MAKE_PARENT=''
   {{> tmpdir-make}}
   printf '%s\n' "$MADE_DIR"
   ```

2. With your file-writing tool, not the shell, create `request.txt` in that
   directory holding a {{request_placeholder}}, ending with one newline.

Then run the block with `TEXT_DIR` set to that directory; a request file left
unwritten stops it before any write, and the directory is kept for the rerun.
Once `create` has recorded the request, the block releases the directory. When
`AGENTIC_TOPIC` is set (a dispatched run), the block writes it to a directory
of its own, records that instead and releases it on each of its exits; steps
1–2 are not needed, and the block releases no directory its `TEXT_DIR` names.

{{#capability dispatch_target}}
The block prints `OP_DIR=<path>`, this command's operation directory: when
the workflow is a macro's child, its write opens the command's persona
operation there (ADR-0068 Decision 2, item 7). Keep the path for the finalize
block's `OP_DIR`, which releases it after the operation's last write.

{{/capability}}
```bash
TEXT_DIR='<directory from step 1>'
ROOT_OVERRIDE="$(printenv {{root_env}} || true)"
CLAUDE_PLUGIN_ROOT="${ROOT_OVERRIDE:-${CLAUDE_PLUGIN_ROOT}}"
[ -n "$CLAUDE_PLUGIN_ROOT" ] || CLAUDE_PLUGIN_ROOT="$(find ~/.claude/plugins/cache/agentic-plugins/{{name}} -mindepth 1 -maxdepth 1 -type d 2>/dev/null | grep -E '/(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$' | sort -V | tail -1)"
VERB={{verb}}
DEFAULT_PROFILE={{default_profile}}
# A fresh shell: nothing is carried from the Phase 0 block.
REPO_ROOT="$(git rev-parse --show-toplevel)" || exit 1
GIT_BRANCH="$(git branch --show-current)"
GIT_HEAD="$(git rev-parse HEAD)"
STATUS_DIGEST="$(git status --porcelain=v1 -z --untracked-files=normal | shasum -a 256 | cut -d' ' -f1)"
{{#capability dispatch_target}}
# The parent linkage /orchestrator:next exports when it dispatches this
# command (ADR-0019 §3): both ids, or neither for a direct invocation. The
# macro's path and the dispatch selection (ADR-0067 Decisions 3 and 4) are
# valid only with both ids; an older orchestrator sets neither of the two.
PARENT_ARGS=()
if [ -n "${AGENTIC_PARENT_WORKFLOW:-}" ] || [ -n "${AGENTIC_ORIGINATING_SUBTASK:-}" ]; then
  if [ -z "${AGENTIC_PARENT_WORKFLOW:-}" ] || [ -z "${AGENTIC_ORIGINATING_SUBTASK:-}" ]; then
    echo "✗ AGENTIC_PARENT_WORKFLOW and AGENTIC_ORIGINATING_SUBTASK must be set together (ADR-0019 §3 immutable parent-child linkage). This usually indicates a dispatcher bug — /orchestrator:next must export both env vars or neither. If you set them manually, set both or neither." >&2
    exit 1
  fi
  PARENT_ARGS=(--parent-workflow "$AGENTIC_PARENT_WORKFLOW" --originating-subtask "$AGENTIC_ORIGINATING_SUBTASK")
  if [ -n "${AGENTIC_PARENT_WORKFLOW_PATH:-}" ]; then
    PARENT_ARGS+=(--parent-workflow-path "$AGENTIC_PARENT_WORKFLOW_PATH")
  fi
  if [ -n "${AGENTIC_DISPATCH_SELECTION:-}" ]; then
    PARENT_ARGS+=(--dispatch-selection "$AGENTIC_DISPATCH_SELECTION")
  fi
elif [ -n "${AGENTIC_PARENT_WORKFLOW_PATH:-}" ]; then
  echo "✗ AGENTIC_PARENT_WORKFLOW_PATH is set without AGENTIC_PARENT_WORKFLOW and AGENTIC_ORIGINATING_SUBTASK (ADR-0067 Decision 3: the macro path is valid only with both ids). This usually indicates a dispatcher bug, or a variable left over from another session; unset it, or set all three." >&2
  exit 1
elif [ -n "${AGENTIC_DISPATCH_SELECTION:-}" ]; then
  echo "✗ AGENTIC_DISPATCH_SELECTION is set without AGENTIC_PARENT_WORKFLOW and AGENTIC_ORIGINATING_SUBTASK (ADR-0067 Decision 4, item 5: the dispatch selection is valid only with both ids). This usually indicates a dispatcher bug, or a variable left over from another session; unset it, or set all three." >&2
  exit 1
fi
{{/capability}}
# The directories this block makes for itself (ADR-0059 Decision 10, item
# 1), released on each of its exits from the variables their makes printed
# to: the topic directory always, and, when the block fails, the operation
# directory, which every run makes afresh.
TOPIC_DIR=''
{{#capability dispatch_target}}
unset OP_DIR
{{/capability}}
release_own() {
  OWN_RC=$?
  RELEASE_PATH="$TOPIC_DIR"
  {{> tmpdir-release}}
{{#capability dispatch_target}}
  if [ "$OWN_RC" -ne 0 ]; then
    RELEASE_PATH="$OP_DIR"
    {{> tmpdir-release}}
  fi
{{/capability}}
  return "$OWN_RC"
}
trap release_own EXIT
# The request, as a file (ADR-0059, amendment of 2026-10-10): the one the
# agent wrote, or the AGENTIC_TOPIC a dispatcher exports, written here to a
# private directory of its own.
REQUEST_FILE="$TEXT_DIR/request.txt"
if [ -n "${AGENTIC_TOPIC:-}" ]; then
  MAKE_KIND='text'
  MAKE_PARENT=''
  {{> tmpdir-make}}
  TOPIC_DIR="$MADE_DIR"
  REQUEST_FILE="$TOPIC_DIR/topic.txt"
  printf '%s\n' "$AGENTIC_TOPIC" > "$REQUEST_FILE" || exit 1
fi
grep -q '[^[:space:]]' "$REQUEST_FILE" 2>/dev/null || { echo "✗ request.txt in TEXT_DIR ($TEXT_DIR) is missing or blank; write it with the file tool first. Nothing was written." >&2; exit 1; }
{{#capability dispatch_target}}
# ADR-0068 Decision 2, item 7 — this command's operation directory.
MAKE_KIND='op'
MAKE_PARENT=''
{{> tmpdir-make}}
OP_DIR="$MADE_DIR"
{{/capability}}
ACTIVE="$(node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" create \
  --repo-root "$REPO_ROOT" \
  --verb {{verb}} --host "${AGENTIC_HOST:-claude}" --persona {{name}} \
  --git-baseline-branch "$GIT_BRANCH" --git-baseline-head "$GIT_HEAD" \
  --status-digest "$STATUS_DIGEST" \
  --profile "${AGENTIC_PROFILE:-<profile from the arguments above — default ${DEFAULT_PROFILE}>}" \
  --original-request-file "$REQUEST_FILE" \
  --current-phase phase-0-bootstrap \
{{^capability dispatch_target}}
  --next-action "Run ${VERB} skill")" || exit $?
{{/capability}}
{{#capability dispatch_target}}
  --next-action "Run ${VERB} skill" \
  --operation-dir "$OP_DIR" \
  "${PARENT_ARGS[@]}")" || exit $?
echo "OP_DIR=$OP_DIR"
{{/capability}}
# ADR-0059 Decision 10, item 1 — the request is recorded, so the directory
# the agent wrote it in has no reader left; a dispatched run read none.
if [ -z "$TOPIC_DIR" ]; then
  RELEASE_PATH="$TEXT_DIR"
  {{> tmpdir-release}}
fi
```
