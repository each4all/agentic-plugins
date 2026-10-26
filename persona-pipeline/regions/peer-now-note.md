Run it with `DISPATCH_DIR` set to the directory the dispatch ran with (Phase
1's step 1): in a fresh shell, it reads the run from the result the runner
wrote there, `prompt.xml.run.json`, and from the run's handle, and finds the
workflow again, carrying nothing from Phase 1.
{{#capability dispatch_target}}
It appends only to the workflow the dispatch kept there as
`prompt.xml.workflow`, and closes the consultation's operation in `op`, when
the dispatch opened one (ADR-0068 Decision 2, item 7).
{{/capability}}

```bash
DISPATCH_DIR='<the directory the dispatch ran with>'
ROOT_OVERRIDE="$(printenv {{root_env}} || true)"
CLAUDE_PLUGIN_ROOT="${ROOT_OVERRIDE:-${CLAUDE_PLUGIN_ROOT}}"
[ -n "$CLAUDE_PLUGIN_ROOT" ] || CLAUDE_PLUGIN_ROOT="$(find ~/.claude/plugins/cache/agentic-plugins/{{name}} -mindepth 1 -maxdepth 1 -type d 2>/dev/null | grep -E '/(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$' | sort -V | tail -1)"
PERSONA={{name}}
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
ACTIVE="$(node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" find-active --repo-root "$REPO_ROOT")" || exit $?
[ -n "$ACTIVE" ] || { echo "✗ No active ${PERSONA} workflow on this branch; nothing was written." >&2; exit 1; }
# One field of a JSON file, a non-empty string; anything else fails.
FIELD='let r;try{r=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))}catch{process.exit(1)}const v=r&&r[process.argv[2]];if(typeof v!=="string"||v==="")process.exit(1);process.stdout.write(v)'
RUN_JSON="$DISPATCH_DIR/prompt.xml.run.json"
# Only a consultation that succeeded gets a note: the runner's own result says
# so (ok true), read here, never the dispatch shell's exit status (R4 J3).
FAILED="$(node -e 'let r;try{r=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))}catch{process.exit(1)}if(r===null||typeof r!=="object")process.exit(1);if(r.ok===true)process.exit(0);process.stdout.write(String(r.error_kind||r.status||"not ok"));process.exit(2)' "$RUN_JSON")"
case $? in
  0) ;;
  2) echo "✗ The run in DISPATCH_DIR ($DISPATCH_DIR) did not succeed ($FAILED; prompt.xml.err there says why); no note is appended for a failed consultation." >&2; exit 1 ;;
  *) echo "✗ The run's result in DISPATCH_DIR ($DISPATCH_DIR) is missing or unreadable; nothing was written." >&2; exit 1 ;;
esac
RUN_ID="$(node -e "$FIELD" "$RUN_JSON" run_id)" \
  && HANDLE_PATH="$(node -e "$FIELD" "$RUN_JSON" handle_path)" \
  && STDOUT_PATH="$(node -e "$FIELD" "$RUN_JSON" stdout_path)" \
  && PEER="$(node -e "$FIELD" "$HANDLE_PATH" peer_host)" \
  || { echo "✗ The run's result in DISPATCH_DIR ($DISPATCH_DIR), or its handle, is missing or unreadable; nothing was written." >&2; exit 1; }
{{#capability dispatch_target}}
# ADR-0068 Decision 2, item 7 — the note goes to the workflow the dispatch was
# for alone (prompt.xml.workflow, empty for none, where the dispatch kept it):
# a workflow found now that it was not for, a macro's child above all, gets no
# note it never admitted. The note is the consultation's last write: it ends
# the operation the dispatch opened in its operation directory, op, when it
# opened one there.
if [ -f "$DISPATCH_DIR/prompt.xml.workflow" ]; then
  FOR_WORKFLOW="$(cat "$DISPATCH_DIR/prompt.xml.workflow")"
  [ "$FOR_WORKFLOW" = "$ACTIVE" ] || { echo "✗ The consultation in DISPATCH_DIR ($DISPATCH_DIR) was dispatched for ${FOR_WORKFLOW:-no workflow}, not $ACTIVE; no note is appended." >&2; exit 1; }
fi
set --
[ -d "$DISPATCH_DIR/op" ] && set -- --operation-dir "$DISPATCH_DIR/op" --close-operation true
{{/capability}}
node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" append \
  --workflow-path "$ACTIVE" --host "${AGENTIC_HOST:-claude}" \
{{#capability dispatch_target}}
  "$@" \
{{/capability}}
  --phase-label "[Peer] $PEER consultation" \
  --phase-note "peer: $PEER
run_id: $RUN_ID
handle: $HANDLE_PATH
prompt-mode: verbatim

### Response

$(head -c 4000 "$STDOUT_PATH")" \
  --event updated
```
