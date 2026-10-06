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

Once they choose, write the resolution in place of its placeholder line
(between the two `OWNER_RESOLUTION` lines; a line reading `OWNER_RESOLUTION`
alone would end it) and run the block. Inside a `/{{persona}}:start` lifecycle the
block clears the gate and stops there: resume the lifecycle, which makes its
one terminal write; elsewhere it ends the verb:

```bash
ROOT_OVERRIDE="$(printenv {{root_env}} || true)"
CLAUDE_PLUGIN_ROOT="${ROOT_OVERRIDE:-${CLAUDE_PLUGIN_ROOT}}"
[ -n "$CLAUDE_PLUGIN_ROOT" ] || CLAUDE_PLUGIN_ROOT="$(find ~/.claude/plugins/cache/agentic-plugins/{{name}} -mindepth 1 -maxdepth 1 -type d 2>/dev/null | grep -E '/(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$' | sort -V | tail -1)"
PERSONA={{name}}
REPO_ROOT="$(git rev-parse --show-toplevel)" || exit 1
ACTIVE="$(node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" find-active --repo-root "$REPO_ROOT")" || exit $?
[ -n "$ACTIVE" ] || { echo "✗ No active ${PERSONA} workflow on this branch." >&2; exit 1; }
# A gate met inside a /start lifecycle is resolved there: the lifecycle makes
# the one terminal write. A type that cannot be read stops the block.
WF_TYPE="$(node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" read --workflow-path "$ACTIVE" \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{try{process.stdout.write(JSON.parse(s).workflow_type||"verb-chain")}catch{process.exit(1)}})')" \
  || { echo "✗ Could not read the workflow type; nothing was written." >&2; exit 1; }
# The owner's resolution, from a quoted heredoc: no quote, $, backtick or
# backslash in it is read by the shell. An empty read stops the block.
unset RESOLUTION
IFS= read -r -d '' RESOLUTION <<'OWNER_RESOLUTION' || true
<Owner selection: the direction the owner chose, and why>
OWNER_RESOLUTION
[ -n "$RESOLUTION" ] || { echo "✗ No resolution was read; nothing was written." >&2; exit 1; }
# One write records the owner's decision, clears the gate and names the next
# step, so the next step never becomes runnable without the decision behind
# it; the block stops if it fails.
node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" awaiting-owner-clear \
  --workflow-path "$ACTIVE" --host "${AGENTIC_HOST:-claude}" --gate decide-conflict \
  --resolution "$RESOLUTION" \
  --next-step-kind verb --next-step-verb compose --next-step-confidence HIGH || exit $?
if [ "$WF_TYPE" = start ]; then
  echo "→ Gate cleared. Resume the lifecycle with /${PERSONA}:start (\$${PERSONA}:start on Codex); it continues at compose." >&2
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
  --next-action {{next_action}} \
  --next-step-kind verb --next-step-verb compose \
  --next-step-confidence HIGH || exit $?
```

`awaiting-owner-clear` records `### Owner gate resolved: decide-conflict at
<iso>` with the pointer it cleared and the resolution. It refuses, writing nothing,
when the gate set on the workflow is not `decide-conflict`.
{{#capability dispatch_target}}
It refuses under an autopilot run too: only the owner resolves an owner gate.
{{/capability}}
