## Owner decision (recurring-finding)

{{^capability dispatch_target}}
The `recurring-finding` gate is resolved by the owner's decision (ADR-0063 Q2,
ported by ADR-0066 Decision 9), in either of two ways:
{{/capability}}
{{#capability dispatch_target}}
The `recurring-finding` gate is resolved by the owner's decision (ADR-0063
Q2), in either of two ways:
{{/capability}}

- **In this session**, right after the refine stopped on it.
{{^capability dispatch_target}}
- **Later**, when Phase 0's preflight reports a pending `recurring-finding`
  gate (an earlier session stopped on it): present the finding recorded at the
  gate's pointer, the latest `Recurring finding` note.
{{/capability}}
{{#capability dispatch_target}}
- **Later**, when Phase 0's preflight reports a pending `recurring-finding`
  gate (an autopilot run, or an earlier session, stopped on it): present the
  finding recorded at the gate's pointer, the latest `Recurring finding` note.
{{/capability}}

Ask the owner: fix it now, or defer it. The clear records the owner's decision
(`--resolution-file`, the file below) and the next step it implies in one
write, so the
next step never becomes runnable without the decision behind it, and a failure
never leaves the gate's `owner-decision` behind; the same write replaces the
gate's next action. Inside a `/{{persona}}:start` lifecycle both blocks clear
the gate and stop there: resume the lifecycle, which fixes the finding in its
refine phase or continues at its terminal step, and makes its one terminal
write.

The owner's decision reaches `state.mjs` as a file, never in a block: in
shell source a quote, `$`, backtick or line of it would be read as code
(ADR-0059, amendment of 2026-10-10). Before either block:

1. Create a private directory for it, and note the path it prints:

   ```bash
   mktemp -d "${TMPDIR:-/tmp}/agentic-text.XXXXXX"
   ```

2. With your file-writing tool, not the shell, create `resolution.txt` in
   that directory, ending with one newline: for Fix now, `Owner decision: fix
   the finding now` with what the owner added; for Defer, `Owner decision:
   defer the finding` with the reason and where it is tracked. Nothing
   deletes it.

Then run the block with `TEXT_DIR` set to that directory; a resolution left
unwritten stops it before any write.

This refine closes only once it converged (`terminal_requires_convergence`),
and deferring a finding does not make it converge. In the Defer block, set
`CONVERGED` to `yes` only when the re-critique, with the finding deferred,
converged by the convergence rule above; anything else, an unset value
included, reads as not converged. Converged, the Defer block clears the gate
with `commit` next and ends the verb. Not converged, it clears the gate with
the next step that resolves what is still open (`refine`, `decide` or
`investigate`) and makes no terminal write: the gate's write turned the
terminal marker off, so the workflow stays open and the Stop hook cannot
archive it. For that case also write `next-action.txt` beside the resolution:
what the next step resolves, in a few words.

**Fix now.** Clear the gate with this refine as the next step, then run the
phases above on that finding, as usual (inside a `/{{persona}}:start`
lifecycle, resume the lifecycle instead):

```bash
TEXT_DIR='<directory from step 1>'
ROOT_OVERRIDE="$(printenv {{root_env}} || true)"
CLAUDE_PLUGIN_ROOT="${ROOT_OVERRIDE:-${CLAUDE_PLUGIN_ROOT}}"
[ -n "$CLAUDE_PLUGIN_ROOT" ] || CLAUDE_PLUGIN_ROOT="$(find ~/.claude/plugins/cache/agentic-plugins/{{name}} -mindepth 1 -maxdepth 1 -type d 2>/dev/null | grep -E '/(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$' | sort -V | tail -1)"
PERSONA={{name}}
REPO_ROOT="$(git rev-parse --show-toplevel)" || exit 1
ACTIVE="$(node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" find-active --repo-root "$REPO_ROOT")" || exit $?
[ -n "$ACTIVE" ] || { echo "✗ No active ${PERSONA} workflow on this branch." >&2; exit 1; }
# A gate met inside a /start lifecycle is resolved there: the lifecycle's
# refine phase runs the fix, and the lifecycle makes the one terminal write,
# which this refine's own phases would make otherwise. A failed read, or a type
# that cannot be parsed, stops the block (the read is checked on its own: a
# pipe reports its last command).
WF_JSON="$(node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" read --workflow-path "$ACTIVE")" \
  || { echo "✗ Could not read the workflow type; nothing was written." >&2; exit 1; }
WF_TYPE="$(printf '%s' "$WF_JSON" \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{try{process.stdout.write(JSON.parse(s).workflow_type||"verb-chain")}catch{process.exit(1)}})')" \
  || { echo "✗ Could not read the workflow type; nothing was written." >&2; exit 1; }
# The owner's resolution, from the file the agent wrote with its file tool:
# state.mjs reads it itself, so no line of it is shell source. A file left
# unwritten stops the block before any write.
grep -q '[^[:space:]]' "$TEXT_DIR/resolution.txt" 2>/dev/null || { echo "✗ resolution.txt in TEXT_DIR ($TEXT_DIR) is missing or blank; write it with the file tool first. Nothing was written." >&2; exit 1; }
if [ "$WF_TYPE" = start ]; then
  NEXT_ACTION="Resume /${PERSONA}:start: its refine phase fixes the recurring finding"
else
  NEXT_ACTION='Fix the recurring finding in this refine, then re-critique'
fi
node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" awaiting-owner-clear \
  --workflow-path "$ACTIVE" --host "${AGENTIC_HOST:-claude}" --gate recurring-finding \
  --resolution-file "$TEXT_DIR/resolution.txt" --next-action "$NEXT_ACTION" \
  --next-step-kind verb --next-step-verb refine --next-step-confidence HIGH || exit $?
if [ "$WF_TYPE" = start ]; then
  echo "→ Gate cleared. Resume the lifecycle with /${PERSONA}:start (\$${PERSONA}:start on Codex); its refine phase fixes the finding." >&2
  exit 0
fi
```

{{^capability commit_surface}}
**Defer.** Clear the gate with the deferral and `commit` as the next step (the
owner saves and commits the artifact; {{persona}} runs no commit itself), then
end the verb:
{{/capability}}
{{#capability commit_surface}}
**Defer.** Clear the gate with the deferral and `commit` as the next step
(`/{{persona}}:commit` commits the change, or closes the workflow when there is
none), then end the verb:
{{/capability}}

```bash
TEXT_DIR='<directory from step 1>'
ROOT_OVERRIDE="$(printenv {{root_env}} || true)"
CLAUDE_PLUGIN_ROOT="${ROOT_OVERRIDE:-${CLAUDE_PLUGIN_ROOT}}"
[ -n "$CLAUDE_PLUGIN_ROOT" ] || CLAUDE_PLUGIN_ROOT="$(find ~/.claude/plugins/cache/agentic-plugins/{{name}} -mindepth 1 -maxdepth 1 -type d 2>/dev/null | grep -E '/(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$' | sort -V | tail -1)"
PERSONA={{name}}
REPO_ROOT="$(git rev-parse --show-toplevel)" || exit 1
ACTIVE="$(node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" find-active --repo-root "$REPO_ROOT")" || exit $?
[ -n "$ACTIVE" ] || { echo "✗ No active ${PERSONA} workflow on this branch." >&2; exit 1; }
# A gate met inside a /start lifecycle is resolved there: the lifecycle makes
# the one terminal write. A failed read, or a type that cannot be parsed, stops
# the block (the read is checked on its own: a pipe reports its last command).
WF_JSON="$(node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" read --workflow-path "$ACTIVE")" \
  || { echo "✗ Could not read the workflow type; nothing was written." >&2; exit 1; }
WF_TYPE="$(printf '%s' "$WF_JSON" \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{try{process.stdout.write(JSON.parse(s).workflow_type||"verb-chain")}catch{process.exit(1)}})')" \
  || { echo "✗ Could not read the workflow type; nothing was written." >&2; exit 1; }
# The owner's resolution, from the file the agent wrote with its file tool:
# state.mjs reads it itself, so no line of it is shell source. A file left
# unwritten stops the block before any write.
grep -q '[^[:space:]]' "$TEXT_DIR/resolution.txt" 2>/dev/null || { echo "✗ resolution.txt in TEXT_DIR ($TEXT_DIR) is missing or blank; write it with the file tool first. Nothing was written." >&2; exit 1; }
if [ "$WF_TYPE" = start ]; then
  NEXT_ACTION="Resume /${PERSONA}:start: the finding is deferred, and the lifecycle continues at its terminal step"
else
{{^capability commit_surface}}
  NEXT_ACTION='The recurring finding is deferred; the owner saves and commits the refined artifact'
{{/capability}}
{{#capability commit_surface}}
  NEXT_ACTION='Commit the refined change; the recurring finding is deferred'
{{/capability}}
fi
# FAIL-CLOSED: shell state does not survive between Bash calls, so an unset
# CONVERGED reads as not converged, never as success. Assign it here, from
# the re-critique verdict with the finding deferred.
CONVERGED="<yes|no — from the re-critique verdict with the finding deferred; unset means no>"
if [ "${CONVERGED:-no}" = "yes" ]; then
  node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" awaiting-owner-clear \
    --workflow-path "$ACTIVE" --host "${AGENTIC_HOST:-claude}" --gate recurring-finding \
    --resolution-file "$TEXT_DIR/resolution.txt" --next-action "$NEXT_ACTION" \
    --next-step-kind commit --next-step-confidence HIGH || exit $?
  if [ "$WF_TYPE" = start ]; then
    echo "→ Gate cleared. Resume the lifecycle with /${PERSONA}:start (\$${PERSONA}:start on Codex); it continues at its terminal step." >&2
    exit 0
  fi
  # ARCHIVE TIMING — this finish-verb is a terminal write: on Claude the Stop
  # hook fires at EVERY turn end, so the archive gates are evaluated at the end
  # of THIS turn (they pass once HEAD has moved). Clearing the marker with
  # `--terminal-marker false` works only before that Stop fires and needs
  # set-terminal's full flag set. On Codex the Stop hook runs only once the
  # operator has trusted the plugin hooks (`/hooks`). Full contract:
  # core/skills/_shared/references/session-handoff.md § Archive timing.
  node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" finish-verb \
    --workflow-path "$ACTIVE" --host "${AGENTIC_HOST:-claude}" \
  {{^capability commit_surface}}
    --next-action 'The recurring finding is deferred; the owner saves and commits the refined artifact' \
  {{/capability}}
  {{#capability commit_surface}}
    --next-action 'Commit the refined change; the recurring finding is deferred' \
  {{/capability}}
    --next-step-kind commit --next-step-confidence HIGH || exit $?
else
  # Not converged: the gate is cleared with the next step that resolves what
  # is still open, and no terminal write is made. Its action is a file the
  # agent wrote too; one left unwritten stops the block before the clear.
  grep -q '[^[:space:]]' "$TEXT_DIR/next-action.txt" 2>/dev/null || { echo "✗ next-action.txt in TEXT_DIR ($TEXT_DIR) is missing or blank; write it with the file tool first. Nothing was written." >&2; exit 1; }
  node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" awaiting-owner-clear \
    --workflow-path "$ACTIVE" --host "${AGENTIC_HOST:-claude}" --gate recurring-finding \
    --resolution-file "$TEXT_DIR/resolution.txt" --next-action-file "$TEXT_DIR/next-action.txt" \
    --next-step-kind verb --next-step-verb "<refine|decide|investigate>" \
    --next-step-confidence "<HIGH|MEDIUM|LOW>" || exit $?
  echo "→ PAUSED (not converged): the gate is cleared and the workflow stays open, not terminal. Run the next step recorded above (inside a /${PERSONA}:start lifecycle, resume it with /${PERSONA}:start)." >&2
fi
```

`awaiting-owner-clear` records `### Owner gate resolved: recurring-finding at
<iso>` with the pointer it cleared and the resolution, and replaces the gate's
next action. It refuses, writing
nothing, when the gate set on the workflow is not `recurring-finding`.
{{#capability dispatch_target}}
It refuses under an autopilot run too: only the owner resolves an owner gate.
{{/capability}}
