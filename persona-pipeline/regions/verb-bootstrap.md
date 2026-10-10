The request reaches `state.mjs` as a file, never in the block: in shell
source a quote, `$`, backtick or line break of it would be read as code
(ADR-0059, amendment of 2026-10-10). Before the block:

1. Create a private directory for it, and note the path it prints:

   ```bash
   mktemp -d "${TMPDIR:-/tmp}/agentic-text.XXXXXX"
   ```

2. With your file-writing tool, not the shell, create `request.txt` in that
   directory holding a {{request_placeholder}}, ending with one newline.
   Nothing deletes it.

Then run the block with `TEXT_DIR` set to that directory; a request file left
unwritten stops it before any write. When `AGENTIC_TOPIC` is set (a dispatched
run), the block writes it to a file of its own and records that instead, and
steps 1–2 are not needed.

```bash
TEXT_DIR='<directory from step 1>'
ROOT_OVERRIDE="$(printenv {{root_env}} || true)"
CLAUDE_PLUGIN_ROOT="${ROOT_OVERRIDE:-${CLAUDE_PLUGIN_ROOT}}"
[ -n "$CLAUDE_PLUGIN_ROOT" ] || CLAUDE_PLUGIN_ROOT="$(find ~/.claude/plugins/cache/agentic-plugins/{{name}} -mindepth 1 -maxdepth 1 -type d 2>/dev/null | grep -E '/(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$' | sort -V | tail -1)"
VERB={{verb}}
GIT_BRANCH="$(git branch --show-current)"
GIT_HEAD="$(git rev-parse HEAD)"
STATUS_DIGEST="$(git status --porcelain=v1 -z --untracked-files=normal | shasum -a 256 | cut -d' ' -f1)"
{{#capability dispatch_target}}
# ADR-0019 §1+§3 — when /orchestrator:next dispatches this command,
# it sets AGENTIC_PARENT_WORKFLOW + AGENTIC_ORIGINATING_SUBTASK so
# the create-time bootstrap records the immutable parent linkage.
# Both must be set together (or both absent for direct invocation).
# ADR-0067 Decision 3 — it also sets AGENTIC_PARENT_WORKFLOW_PATH, the
# macro file's absolute path, recorded beside them; an older orchestrator
# sets none. The path is valid only with both ids.
# ADR-0067 Decision 4, item 5 — and AGENTIC_DISPATCH_SELECTION, the selection
# its Phase 1 made (JSON: subtask, branch, verb, profile, topic), recorded
# beside them for every later binding to compare; also valid only with both.
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
# The request, as a file (ADR-0059, amendment of 2026-10-10): the one the
# agent wrote, or the AGENTIC_TOPIC a dispatcher exports, which is program data
# the block writes to a private directory of its own, so no text flag is
# inline and a dispatched run needs no file of the agent's.
REQUEST_FILE="$TEXT_DIR/request.txt"
if [ -n "${AGENTIC_TOPIC:-}" ]; then
  REQUEST_FILE="$(mktemp -d "${TMPDIR:-/tmp}/agentic-text.XXXXXX")/topic.txt" || exit 1
  printf '%s\n' "$AGENTIC_TOPIC" > "$REQUEST_FILE" || exit 1
fi
grep -q '[^[:space:]]' "$REQUEST_FILE" 2>/dev/null || { echo "✗ request.txt in TEXT_DIR ($TEXT_DIR) is missing or blank; write it with the file tool first. Nothing was written." >&2; exit 1; }
ACTIVE="$(node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" create \
  --repo-root "$REPO_ROOT" \
  --verb {{verb}} --host "${AGENTIC_HOST:-claude}" --persona {{name}} \
  --git-baseline-branch "$GIT_BRANCH" --git-baseline-head "$GIT_HEAD" \
  --status-digest "$STATUS_DIGEST" \
  --original-request-file "$REQUEST_FILE" \
  --current-phase phase-0-bootstrap \
{{^capability dispatch_target}}
  --next-action "Run ${VERB} skill")" || exit $?
{{/capability}}
{{#capability dispatch_target}}
  --next-action "Run ${VERB} skill" \
  "${PARENT_ARGS[@]}")" || exit $?
{{/capability}}
```
