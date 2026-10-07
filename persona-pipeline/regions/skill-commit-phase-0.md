```bash
PERSONA={{name}}
REPO_ROOT="$(git rev-parse --show-toplevel)" || exit 1
GIT_BRANCH="$(git branch --show-current)"
if [ -z "$GIT_BRANCH" ]; then
  echo "✗ Detached HEAD detected — ${PERSONA} workflows are anchored to a branch (ADR-0018 §sub-2)." >&2
  exit 1
fi
ACTIVE="$(node "<plugin-root>/scripts/state.mjs" find-active --repo-root "$REPO_ROOT")" || exit $?
if [ -z "$ACTIVE" ]; then
  echo "✗ No active ${PERSONA} workflow on $GIT_BRANCH — nothing for /${PERSONA}:commit to commit or close." >&2
  exit 1
fi
# The read is checked on its own: a read that fails stops the block, whatever
# it printed, before the type is parsed.
WF_JSON="$(node "<plugin-root>/scripts/state.mjs" read --workflow-path "$ACTIVE")" || exit $?
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
node "<plugin-root>/scripts/state.mjs" autopilot-preflight \
  --workflow-path "$ACTIVE" --host <claude|codex> --surface commit || exit $?
echo "Workflow: $ACTIVE"
```

- The block stops, with the reason, on a detached HEAD, on a branch with no
  active workflow, and on a `/{{persona}}:start` workflow (`workflow_type:
  start`), whose own Phase 7 commits it; a workflow it cannot read stops it
  too.
{{#capability dispatch_target}}
- The preflight printed the **autopilot banner** (Claude only) → run
  `phase7-commit.mjs --mode autopilot` and report its `action`; that is the
  whole step. It commits only when the staging set is fully implied, the
  workflow began on a clean tree and nothing is pre-staged; otherwise it
  stops at the `staging-set` owner gate.
{{/capability}}
- It printed a pending **`staging-set`** gate → the owner has to confirm
{{#capability dispatch_target}}
  the staging set an autopilot run stopped on.
{{/capability}}
{{^capability dispatch_target}}
  the staging set the gate names.
{{/capability}}
  Continue with Phase 1 and clear the gate in Phase 2 once they do.
- It printed **any other** pending gate → stop and put it to the user; that
  gate is resolved by the surface the notice names. Execute and close refuse
  while any owner gate is set.
