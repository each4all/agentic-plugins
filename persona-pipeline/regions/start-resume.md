When the arguments above are a new request that does not belong to the active
workflow (its `original_request` says what it holds), do not run the first
block below, whichever the workflow's type: a start never takes unrelated work
into a workflow, and the block would resume it. Propose a worktree for the
request instead, with the second block, and leave the active workflow as it is
(ADR-0067 Decision 8, item 3). When the arguments are empty, or continue that
workflow, the ordinary resume is the selection: run the first block.

```bash
ROOT_OVERRIDE="$(printenv {{root_env}} || true)"
CLAUDE_PLUGIN_ROOT="${ROOT_OVERRIDE:-${CLAUDE_PLUGIN_ROOT}}"
[ -n "$CLAUDE_PLUGIN_ROOT" ] || CLAUDE_PLUGIN_ROOT="$(find ~/.claude/plugins/cache/agentic-plugins/{{name}} -mindepth 1 -maxdepth 1 -type d 2>/dev/null | grep -E '/(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$' | sort -V | tail -1)"
PERSONA={{name}}
# The read is checked on its own: a read that fails stops the block, whatever
# it printed, before the type is parsed.
WF_JSON="$(node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" read --workflow-path "$ACTIVE")" || exit $?
WF_TYPE="$(printf '%s' "$WF_JSON" | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{try{process.stdout.write(JSON.parse(s).workflow_type||"verb-chain")}catch{process.stdout.write("verb-chain")}})')"
# Resuming into the lifecycle clears the next step the last phase recorded, so
# a phase that stops before its own last write leaves none behind (ADR-0063
# D6); the position (verb, phase, next action) is kept. Any other workflow is
# refused, unwritten: the lifecycle never takes a single-verb workflow into
# its phase space (ADR-0020 §Sub-decision 4).
if [ "$WF_TYPE" = start ]; then
  node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" append \
    --workflow-path "$ACTIVE" --host "${AGENTIC_HOST:-claude}" \
    --clear-next-step true --event resumed || exit $?
else
  echo "✗ The active workflow on this branch is workflow_type=${WF_TYPE}, not start: /${PERSONA}:start does not take a single-verb workflow into its lifecycle." >&2
  echo "  Active workflow: $ACTIVE" >&2
  echo "  If this request continues it: continue it with its /${PERSONA}:<verb>, or archive it (/${PERSONA}:resume archive), then re-run /${PERSONA}:start." >&2
  echo "  If it is new work: a worktree first, which leaves this branch and its workflow as they are (the worktree block prints the command); switching this checkout's branch (git switch -c <new>) would carry its changes along." >&2
  exit 1
fi
```

{{#capability commit_surface}}
The worktree block, for a new request beside an active workflow, takes the
arguments above through an args file, never through the shell:
{{/capability}}
{{^capability commit_surface}}
The worktree block, for a new request beside an active workflow and for the
bootstrap's dirty refusal above, takes the arguments above through an args
file, never through the shell:
{{/capability}}

1. Create a private directory for the file, and note the path it prints:
   `mktemp -d "${TMPDIR:-/tmp}/agentic-args.XXXXXX"`.
2. With your file-writing tool, not the shell, create `args.json` in it
   holding `{"agentic_args": 1, "text": "…"}`, with `text` set to the
   arguments exactly as typed, as a JSON string.

Then run the block with `ARGS_DIR` set to that directory. It prints the
runtime:worktree planner's `git worktree add` command for the request,
{{#capability commit_surface}}
from the `--base-branch <ref>` in it when there is one,
{{/capability}}
or why there is none, and writes nothing; the args file is removed once read.

```bash
ARGS_DIR='<directory from step 1>'
ROOT_OVERRIDE="$(printenv {{root_env}} || true)"
CLAUDE_PLUGIN_ROOT="${ROOT_OVERRIDE:-${CLAUDE_PLUGIN_ROOT}}"
[ -n "$CLAUDE_PLUGIN_ROOT" ] || CLAUDE_PLUGIN_ROOT="$(find ~/.claude/plugins/cache/agentic-plugins/{{name}} -mindepth 1 -maxdepth 1 -type d 2>/dev/null | grep -E '/(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$' | sort -V | tail -1)"
REPO_ROOT="$(git rev-parse --show-toplevel)"
node "$CLAUDE_PLUGIN_ROOT/scripts/discover-runtime.mjs" worktree-plan --repo-root "$REPO_ROOT" \
  --args-file "$ARGS_DIR/args.json" --host "${AGENTIC_HOST:-claude}" --format text
```
