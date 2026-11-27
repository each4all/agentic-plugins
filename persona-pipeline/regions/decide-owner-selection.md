## Owner selection (decide-conflict)

{{^capability dispatch_target}}
The `decide-conflict` gate is resolved by the owner's selection (ADR-0063 Q2,
ported by ADR-0066 Decision 9), in either of two ways:
{{/capability}}
{{#capability dispatch_target}}
The `decide-conflict` gate is resolved by the owner's selection (ADR-0063
Q2), in either of two ways:
{{/capability}}

- **In this session**, right after `✓ Decision pending user input`: the user
  picks one of the directions just shown.
{{^capability dispatch_target}}
- **Later**, when Phase 0's preflight reports a pending `decide-conflict` gate
  (an earlier session stopped on it): present the directions recorded at the
  gate's pointer, the latest `Ensemble synthesis: decide verdict=conflict`
  note, and ask the user to choose instead of running a new comparison. If
  they want a fresh comparison, clear the gate first and run the phases above
  as usual.
{{/capability}}
{{#capability dispatch_target}}
- **Later**, when Phase 0's preflight reports a pending `decide-conflict` gate
  (an autopilot run, or an earlier session, stopped on it): present the
  directions recorded at the gate's pointer, the latest `Ensemble synthesis:
  decide verdict=conflict` note, and ask the user to choose instead of running
  a new comparison. If they want a fresh comparison, clear the gate first and
  run the phases above as usual.
{{/capability}}

Once they choose, write their selection as a file, never into the block: in
shell source a quote, `$`, backtick or line of it would be read as code
(ADR-0059, amendment of 2026-10-10).

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

2. With your file-writing tool, not the shell, create `resolution.txt` in
   that directory, ending with one newline: `Owner selection: ` with the
   direction the owner chose, and why.

Then run the block with `TEXT_DIR` set to that directory; a selection left
unwritten stops it before any write. Once its last write succeeded, the block
releases the directory, and the operation directories it wrote through
(ADR-0059 Decision 10); a block that stops keeps them for its rerun. Inside a `/{{persona}}:start` lifecycle the
block clears the gate and stops there: resume the lifecycle, which continues at
its own phase after decide and makes its one terminal write; elsewhere it ends
the verb:

{{#capability dispatch_target}}
Set `OP_DIR` to the operation directory this run's Phase 0 printed
(`OP_DIR=<path>`) when you resolve the gate in a later run of the verb; leave
it empty when Phase 0 printed none, and when you resolve it right after this
verb's own finalize, which closed that operation. The block then opens the
resolution's own (ADR-0068 Decision 2, item 7).

{{/capability}}
```bash
TEXT_DIR='<directory from step 1>'
{{#capability dispatch_target}}
OP_DIR='<the operation directory Phase 0 of this run printed as OP_DIR; empty when it printed none or the finalize of this verb already ran>'
{{/capability}}
ROOT_OVERRIDE="$(printenv {{root_env}} || true)"
CLAUDE_PLUGIN_ROOT="${ROOT_OVERRIDE:-${CLAUDE_PLUGIN_ROOT}}"
[ -n "$CLAUDE_PLUGIN_ROOT" ] || CLAUDE_PLUGIN_ROOT="$(find ~/.claude/plugins/cache/agentic-plugins/{{name}} -mindepth 1 -maxdepth 1 -type d 2>/dev/null | grep -E '/(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$' | sort -V | tail -1)"
PERSONA={{name}}
{{#capability dispatch_target}}
# The operation directory this block makes for the resolution when no Phase 0
# opened one (ADR-0059 Decision 10, item 1), released on each of its exits
# from the variable its make printed to: a run that fails makes it afresh, and
# the release keeps one holding an operation still open.
GATE_OP_DIR=''
release_own() {
  OWN_RC=$?
  RELEASE_PATH="$GATE_OP_DIR"
  {{> tmpdir-release}}
  return "$OWN_RC"
}
trap release_own EXIT
{{/capability}}
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
# Inside a /start lifecycle the lifecycle owns its phase order, so the clear
# records no next step (the lifecycle's resume clears one anyway) and names the
# resume as the next action; elsewhere the next step is compose. Either way the
# gate's "Owner: …" next action does not outlive the clear.
{{#capability dispatch_target}}
# ADR-0068 Decision 2, item 7 — the clear and the terminal write below are one
# persona operation of a macro's child: the one this run's Phase 0 opened
# (OP_DIR set), or, with OP_DIR empty, one the clear opens in a directory this
# block makes. Inside a /start lifecycle, where no terminal write follows, the
# clear closes the operation Phase 0 opened, or is its own operation's one
# write.
case "$OP_DIR" in
  *'<'*) echo "✗ OP_DIR is not set to the operation directory this run's Phase 0 printed (empty when it printed none, or when this verb's finalize already ran); nothing was written." >&2; exit 1 ;;
esac
OP_ARGS=()
if [ -n "$OP_DIR" ] && [ "$WF_TYPE" = start ]; then
  OP_ARGS=(--operation-dir "$OP_DIR" --close-operation true)
elif [ -n "$OP_DIR" ]; then
  OP_ARGS=(--operation-dir "$OP_DIR")
elif [ "$WF_TYPE" != start ]; then
  MAKE_KIND='op'
  MAKE_PARENT=''
  {{> tmpdir-make}}
  GATE_OP_DIR="$MADE_DIR"
  OP_ARGS=(--operation-dir "$GATE_OP_DIR" --open-operation gate)
fi
{{/capability}}
if [ "$WF_TYPE" = start ]; then
  NEXT_ACTION="Resume /${PERSONA}:start: the lifecycle continues after decide with the selected direction"
  NEXT_STEP=(--clear-next-step true)
else
  NEXT_ACTION={{next_action}}
  NEXT_STEP=(--next-step-kind verb --next-step-verb compose --next-step-confidence HIGH)
fi
# One write records the owner's decision, clears the gate and names the next
# step, so the next step never becomes runnable without the decision behind
# it; the block stops if it fails.
node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" awaiting-owner-clear \
  --workflow-path "$ACTIVE" --host "${AGENTIC_HOST:-claude}" --gate decide-conflict \
{{#capability dispatch_target}}
  "${OP_ARGS[@]}" \
{{/capability}}
  --resolution-file "$TEXT_DIR/resolution.txt" --next-action "$NEXT_ACTION" \
  "${NEXT_STEP[@]}" || exit $?
if [ "$WF_TYPE" = start ]; then
  echo "→ Gate cleared. Resume the lifecycle with /${PERSONA}:start (\$${PERSONA}:start on Codex); it continues at its phase after decide." >&2
else
  # ARCHIVE TIMING — this finish-verb is a terminal write: on Claude the Stop
  # hook fires at EVERY turn end, so the archive gates are evaluated at the end
  # of THIS turn (they pass once HEAD has moved). Clearing the marker with
  # `--terminal-marker false` works only before that Stop fires and needs
  # set-terminal's full flag set. On Codex the Stop hook runs only once the
  # operator has trusted the plugin hooks (`/hooks`). Full contract:
  # core/skills/_shared/references/session-handoff.md § Archive timing.
  node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" finish-verb \
    --workflow-path "$ACTIVE" --host "${AGENTIC_HOST:-claude}" \
{{#capability dispatch_target}}
    --operation-dir "${GATE_OP_DIR:-$OP_DIR}" \
{{/capability}}
    --next-action {{next_action}} \
    --next-step-kind verb --next-step-verb compose \
    --next-step-confidence HIGH || exit $?
fi
# ADR-0059 Decision 10, item 1 — the last write succeeded (the clear inside a
# lifecycle, the terminal write elsewhere) and closed the operation: no block,
# rerun or continuation reads these directories again.
{{#capability dispatch_target}}
for RELEASE_PATH in "$TEXT_DIR" "$OP_DIR"; do
  {{> tmpdir-release}}
done
{{/capability}}
{{^capability dispatch_target}}
RELEASE_PATH="$TEXT_DIR"
{{> tmpdir-release}}
{{/capability}}
```

`awaiting-owner-clear` records `### Owner gate resolved: decide-conflict at
<iso>` with the pointer it cleared and the resolution, and replaces the gate's
next action. It refuses, writing nothing,
when the gate set on the workflow is not `decide-conflict`.
{{#capability dispatch_target}}
It refuses under an autopilot run too: only the owner resolves an owner gate.
{{/capability}}

When the clear succeeded and the terminal write after it did not, a rerun of
the whole block stops at the clear, since the gate is gone: a rare failure
between the block's two writes, for which the block keeps its directories
(ADR-0059 Decision 10, item 3). Recover by running only the block's
`finish-verb` call, as written, with the same values, once the workflow's
record (`state.mjs read`: `current_phase`, `terminal_marker` and
`next_step`) shows that it did not land. Give it the operation directory
Phase 0 printed when there was one; when the block opened its own, its exit
released it, so run the call with no operation directory, as the write's
refusal of a missing one says (ADR-0059 Decision 10, item 5). `TEXT_DIR` stays
where it is: the runbook releases none by hand (item 2), and the owner lists
and removes it (`tmpdir-list`, item 6).
