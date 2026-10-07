```bash
ROOT_OVERRIDE="$(printenv {{root_env}} || true)"
CLAUDE_PLUGIN_ROOT="${ROOT_OVERRIDE:-${CLAUDE_PLUGIN_ROOT}}"
[ -n "$CLAUDE_PLUGIN_ROOT" ] || CLAUDE_PLUGIN_ROOT="$(find ~/.claude/plugins/cache/agentic-plugins/{{name}} -mindepth 1 -maxdepth 1 -type d 2>/dev/null | grep -E '/(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$' | sort -V | tail -1)"
PERSONA={{name}}
REPO_ROOT="$(git rev-parse --show-toplevel)" || exit 1
GIT_BRANCH="$(git branch --show-current)"
if [ -z "$GIT_BRANCH" ]; then
  echo "✗ Detached HEAD detected — ${PERSONA} workflows are anchored to a branch (ADR-0018 §sub-2)." >&2
  exit 1
fi
ACTIVE="$(node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" find-active --repo-root "$REPO_ROOT")" || exit $?
if [ -z "$ACTIVE" ]; then
  echo "✗ No active ${PERSONA} workflow on $GIT_BRANCH — nothing for /${PERSONA}:commit to commit or close." >&2
  exit 1
fi
# The read is checked on its own: a read that fails stops the block, whatever
# it printed, before the type is parsed.
WF_JSON="$(node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" read --workflow-path "$ACTIVE")" || exit $?
WORKFLOW_TYPE="$(printf '%s' "$WF_JSON" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{process.stdout.write(JSON.parse(d).workflow_type||"verb-chain")}catch{process.exit(1)}})')" || exit 1
if [ "$WORKFLOW_TYPE" = "start" ]; then
  echo "✗ $ACTIVE is an /${PERSONA}:start workflow; its own Phase 7 commits it — continue it with /${PERSONA}:start." >&2
  exit 1
fi
{{#capability dispatch_target}}
# ADR-0063 D4 — prints nothing in interactive mode; this command's autopilot
# rules under an autopilot run; exits 1 under autopilot when an owner gate is
# set; prints a pending gate for the owner otherwise.
{{/capability}}
{{^capability dispatch_target}}
# ADR-0066 Decision 3 — prints nothing interactively; when AGENTIC_AUTOPILOT
# names a run, one line saying the variable is ignored (this persona is no
# autopilot dispatch target); a pending gate for the owner otherwise.
{{/capability}}
node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" autopilot-preflight \
  --workflow-path "$ACTIVE" --host "${AGENTIC_HOST:-claude}" --surface commit || exit $?
echo "Workflow: $ACTIVE"
```

Then:

{{#capability dispatch_target}}
- **The preflight printed the autopilot banner** → run the Autopilot block
  below and nothing else.
{{/capability}}
- **It printed a pending `staging-set` gate** → the owner is here to confirm
{{#capability dispatch_target}}
  the staging set an autopilot run stopped on.
{{/capability}}
{{^capability dispatch_target}}
  the staging set the gate names.
{{/capability}}
  Continue with Phase 1; clear the gate in Phase 2 once they confirm it.
- **It printed any other pending gate** → stop and put it to the user. That
  gate is resolved by the surface the notice names, not by a commit; the
  driver's execute and close modes refuse while any gate is set.
- **It printed nothing** → Phase 1.
