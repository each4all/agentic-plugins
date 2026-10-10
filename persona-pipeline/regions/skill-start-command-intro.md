{{^capability commit_surface}}
Phase 0 host-side bootstrap (argument intake, detached-HEAD guard,
clean-baseline gate, active-workflow branching) is owned by the entry path:
{{/capability}}
{{#capability commit_surface}}
Phase 0 host-side bootstrap (argument intake, detached-HEAD guard,
redundancy probe, clean-baseline gate, active-workflow branching) is owned by
the entry path:
{{/capability}}
`commands/start.md` carries the canonical bash on the Claude side, generated
from the shared start regions (ADR-0066). Direct `${{persona}}:start` on Codex
follows the same operational sequence inline, in this order, using the same
`scripts/state.mjs` CLI (the state writer is host-agnostic):

1. **Guard and find.** Refuse a detached HEAD (workflows are anchored to a
   branch), then `state.mjs find-active --repo-root <root>`, then
   `state.mjs autopilot-preflight --workflow-path <found> --host codex`
   before any write: it reports a pending owner gate and writes nothing.
2. **Active-workflow branching.** `workflow_type` `start` → resume:
   `state.mjs append --workflow-path <found> --host codex --clear-next-step
   true --event resumed`; put an owner gate step 1 reported to the user
   first (once it is resolved, clear it with the phase the lifecycle
   continues at and that phase's `--next-action`), then continue from its
   `current_phase`; no description is needed. Any other workflow
   (`verb-chain`, or a legacy one without the field) → typed conflict:
   refuse, writing nothing, its owner gate included — `start` must not
   absorb a single-verb workflow into lifecycle phase space. The user
   continues it with its `${{persona}}:<verb>`,
{{#capability commit_surface}}
   commits it (`${{persona}}:commit`),
{{/capability}}
   archives it (`${{persona}}:resume`) or switches branch, then runs
   `${{persona}}:start` again. Either type: when the arguments are a new
   request that does not belong to the active workflow, nothing is written;
   the proposal selects a worktree first (ADR-0067 Decision 8, item 3) —
   write the arguments into an args file and run `scripts/discover-runtime.mjs
   worktree-plan --repo-root <root> --args-file <path> --host codex --format
   text`, which prints the runtime:worktree planner's `git worktree add`
   command for the request — and the ordinary resume stays the selection when
   the request belongs to the workflow.
{{^capability commit_surface}}
3. **No active workflow.** The arguments are the description: the
   **clean-baseline gate** below, then `state.mjs create --workflow-type
   start --verb investigate --persona {{persona}} --original-request <the
   description>`.
{{/capability}}
{{#capability commit_surface}}
3. **No active workflow.** The arguments are read from an args file, twice:
   first for the **redundancy probe** (`state.mjs diagnose-redundancy
   --repo-root <root> --base-branch <ref>`, informational — a failed probe
   never stops; a finding is put to the user for proceed or abort, and abort
   writes nothing), then, with a new args file, for the bootstrap: the
   **clean-baseline gate** below, then `state.mjs create --workflow-type
   start --verb investigate --persona {{persona}} --original-request <the
   description>`.

Argument parsing is `scripts/start-args.mjs --args-file <path>` on both
hosts (ADR-0059 Decision 7). The description, with any
`--base-branch <ref>` in it, goes into an args file — never into a command
line, where an apostrophe aborts the line and `;` or `$(…)` cuts or runs it.
Write `{"agentic_args": 1, "text": "…"}` with the file-editing tool into a
directory from `mktemp -d "${TMPDIR:-/tmp}/agentic-args.XXXXXX"`, then run
the extractor in the same shell as the steps that read `BASE_BRANCH` and
`FEATURE`. It removes the args file and its directory once it has read them,
so running it again needs a new args file:

```bash
ARGS_DIR='<directory mktemp printed>'
START_ARGS="$(node "<plugin-root>/scripts/start-args.mjs" --args-file "$ARGS_DIR/args.json")" || exit $?
printf '%s\n' "$START_ARGS"
BASE_BRANCH="$(printf '%s' "$START_ARGS" | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>process.stdout.write(JSON.parse(s).base_branch))')" || exit $?
# A command substitution drops trailing newlines; the sentinel keeps them.
FEATURE="$(printf '%s' "$START_ARGS" | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>process.stdout.write(JSON.parse(s).feature))'; printf x)"; FEATURE="${FEATURE%x}"
```
{{/capability}}

{{^capability commit_surface}}
The **clean-baseline gate** runs on the bootstrap branch (when `find-active`
{{/capability}}
{{#capability commit_surface}}
The **clean-baseline gate** (ADR-0028 §Layer-1) runs on the bootstrap branch
(when `find-active`
{{/capability}}
returns empty and a new workflow is about to be created) before `state.mjs
create`. It calls `state.mjs check-clean-baseline --repo-root <root>` (with
`--accept-current-tree true` once the user accepts the current tree, as
`ACCEPT_CURRENT_TREE=1` does in the command) and inspects the returned
`status` (`clean` / `dirty` / `accepted`). The gate fails closed: only an
explicit `clean` / `accepted` status proceeds; a non-zero check, a `dirty`
tree, or an unparseable status stops the bootstrap. On `dirty` the gate
refuses to bootstrap and selects a worktree first (ADR-0067 Decision 8,
item 3): with the arguments in a new args file, never on a command line
(`{"agentic_args": 1, "text": "…"}`, written with the file-editing tool into a
directory from `mktemp -d "${TMPDIR:-/tmp}/agentic-args.XXXXXX"`; the reader
removes it), `scripts/discover-runtime.mjs worktree-plan --repo-root <root>
--args-file <path> --host codex --format text` prints the runtime:worktree
planner's `git worktree add -b <branch> <path> <base>` for the request,
{{#capability commit_surface}}
from the `--base-branch <ref>` in it when there is one,
{{/capability}}
to run before the start again inside the new worktree, or why there is none
(no runtime with the planner, an existing branch, an occupied path, an
unresolved base). The resolutions here stay the rejected alternatives:
{{^capability commit_surface}}
clean the tree, stash, or set `ACCEPT_CURRENT_TREE=1` to acknowledge the
dirty tree. `.agentic-plugins/state/**` is excluded from the dirty check.
{{/capability}}
{{#capability commit_surface}}

- **clean** — `git restore . ; git clean -fd` and re-run;
- **stash** — `git stash push --include-untracked`, re-run, then `git stash pop`;
- **accept-current-tree** — set `ACCEPT_CURRENT_TREE=1` before re-running.
  The workflow's commit will sweep whatever was in the tree; the user
  acknowledges this.

`.agentic-plugins/state/**` is excluded from the dirty check — workflow
storage is the persona's own bookkeeping and never counts. An accepted tree
is not remembered: Phase 7 stages all of `git_changes` rather than the
manifest intersection only when it is told again, so pass
`--accept-current-tree` to both of its modes (the plan too, so its preview
matches what execute commits).
{{/capability}}

**Inside the lifecycle** (both hosts, ADR-0066 PC2b): Phase 0 runs
`state.mjs autopilot-preflight` once, before any write, and a resumed start
workflow clears the next step it carried. Each phase's ensemble attempt is
settled from its run ledger (`peer-runner.mjs settle`) before the next phase,
a repeated phase under a new run id. No phase makes a verb's terminal write;
{{^capability commit_surface}}
the lifecycle's one terminal write is `finish-verb` at the end, once it
converged where the persona waits for convergence.
{{/capability}}
{{#capability commit_surface}}
the lifecycle's one terminal write is the Phase 7 commit driver
(`phase7-commit.mjs` in execute mode, which writes `set-terminal` last).
{{/capability}}
An owner gate met in a
phase (a decide CONFLICT, a recurring finding) is recorded with
`state.mjs awaiting-owner-set`, which leaves the workflow open; the lifecycle
pauses, and continues at the next phase once the owner's decision clears it
(`state.mjs awaiting-owner-clear` with that phase as the next step and its
action as the next action).
