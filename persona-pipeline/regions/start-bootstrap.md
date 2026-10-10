{{#capability commit_surface}}
The arguments above are the {{request_placeholder}}, with an optional
`--base-branch <ref>` anywhere in it (ADR-0059 Decision 7;
`scripts/start-args.mjs`). Empty arguments are refused (exit 2), so the
workflow's `original_request` has substance; `<ref>` is the redundancy
probe's base, `origin/main` when it is omitted. They reach the extractor
through an args file, never through the shell (ADR-0059): typed text spliced
into a command line is cut at `;`, expanded at `$(…)` and redirected at `>`,
and the damage can exit zero. Before each of the two blocks below:

1. Create a private directory for the file, and note the path it prints:

   ```bash
   mktemp -d "${TMPDIR:-/tmp}/agentic-args.XXXXXX"
   ```

2. With your file-writing tool, not the shell, create `args.json` in that
   directory holding `{"agentic_args": 1, "text": "…"}`, with `text` set to
   the arguments above exactly as typed, as a JSON string (`""` when there
   are none).

Then run the block with `ARGS_DIR` set to that directory. The extractor takes
the text as the description and removes one `--base-branch <ref>` wherever it
sits; a second `--base-branch`, the `--base-branch=<ref>` spelling, or a
missing ref is refused. Nothing else in the description is quoted, expanded
or split. It removes the args file and its directory once it has read them,
so the second block needs a new one.

The redundancy probe (ADR-0020 §Sub-decision 7) asks whether this branch
already holds overlapping work: recent commits and open pull requests against
the base. It writes nothing, and a failed probe never blocks the start.

```bash
ARGS_DIR='<directory from step 1>'
ROOT_OVERRIDE="$(printenv {{root_env}} || true)"
CLAUDE_PLUGIN_ROOT="${ROOT_OVERRIDE:-${CLAUDE_PLUGIN_ROOT}}"
[ -n "$CLAUDE_PLUGIN_ROOT" ] || CLAUDE_PLUGIN_ROOT="$(find ~/.claude/plugins/cache/agentic-plugins/{{name}} -mindepth 1 -maxdepth 1 -type d 2>/dev/null | grep -E '/(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$' | sort -V | tail -1)"
REPO_ROOT="$(git rev-parse --show-toplevel)"
GIT_BRANCH="$(git branch --show-current)"
START_ARGS="$(node "$CLAUDE_PLUGIN_ROOT/scripts/start-args.mjs" --args-file "$ARGS_DIR/args.json")" || exit $?
BASE_BRANCH="$(printf '%s' "$START_ARGS" | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>process.stdout.write(JSON.parse(s).base_branch))')" || exit $?
DIAG="$(node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" diagnose-redundancy \
  --repo-root "$REPO_ROOT" --base-branch "$BASE_BRANCH")"
DIAG_RC=$?
if [ "$DIAG_RC" -ne 0 ]; then
  # The probe is informational: a failed probe never blocks the start.
  echo "⚠ diagnose-redundancy failed (exit $DIAG_RC); its error is above. Proceeding without overlap detection." >&2
  DIAG=''
fi
# One line: the status, then whether git was found and whether the base resolved.
FINDING="$(printf '%s' "$DIAG" | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{let r={};try{r=JSON.parse(s)||{}}catch{}const sc=r.scanned||{};process.stdout.write([r.status||"",sc.git_present===false?"no-git":"",sc.base_resolution_failed===true?"no-base":""].join(" "))})')"
case "$FINDING" in
  *no-git*) echo "⚠ git is not on PATH — the redundancy probe is blind. Proceeding without overlap detection." ;;
  *no-base*) echo "⚠ Base branch '$BASE_BRANCH' did not resolve — pass --base-branch <ref> if another base applies (e.g. stacked branches). Proceeding without overlap detection." ;;
  redundancy*)
    echo "⚠ Redundancy detected on branch '$GIT_BRANCH' (base=$BASE_BRANCH):"
    printf '%s' "$DIAG" | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{const r=JSON.parse(s);for(const k of ["scanned","evidence","recommended_action"])console.log(JSON.stringify(r[k],null,2))})'
    echo
    echo "  Options:"
    echo "    - proceed: run the bootstrap block below if the evidence is unrelated"
    echo "    - abort:   stop here; review the evidence (recent commits / open PRs)"
    echo "               and either continue the existing PR or archive it first"
    echo "→ PAUSED: put the evidence to the user and wait for proceed or abort." ;;
esac
```

On a redundancy finding, put the evidence to the user and ask for an
explicit proceed-or-abort decision: `/{{persona}}:start` never archives on
redundancy, which is a user judgment, not a plugin policy. Abort stops here,
with nothing written. A missing git or an unresolved base is informational.

To proceed, or when the probe found nothing, run the bootstrap block with a
new args file (steps 1–2). It runs the clean-baseline gate (ADR-0028
§Layer-1) before `state.mjs create`: the Phase 7 commit stages the paths the
workflow recorded that git shows changed, a signal that holds only when the
baseline was clean. A dirty baseline would let the commit sweep adjacent,
unrelated changes into the workflow's commit, unless the user accepts the
current tree (`ACCEPT_CURRENT_TREE=1`), which stages all of it at Phase 7.
`.agentic-plugins/state/**`, the workflow storage, never counts as dirty.
{{/capability}}
{{^capability commit_surface}}
In the block, replace `<the original request described above>` with a
{{request_placeholder}}; `AGENTIC_TOPIC` takes its place when it is set. The
block sets the repository and branch itself: a shell variable does not outlive
a Bash call.
{{/capability}}

A dirty tree's refusal selects a worktree first (ADR-0067 Decision 8, item 3):
`scripts/discover-runtime.mjs worktree-plan` prints the runtime:worktree
planner's `git worktree add -b <branch> <path> <base>` for this request, to
run before `/{{persona}}:start` again inside the new worktree; this checkout's
changes stay where they are. It is the refusal's `selected_next`. Cleaning,
stashing or accepting the tree here stay among the rejected alternatives: right
when the changes are finished or belong to this request, wrong when they are
other work. When no runtime with the planner resolves, or the planner blocks
(an existing branch, an occupied path, an unresolved base), the line names the
reason and `/runtime:worktree plan`.
{{#capability commit_surface}}
The refusal plans it for the description and base the args file held.
{{/capability}}
{{^capability commit_surface}}
The request reaches the planner through an args file, never through the
shell: the refusal names the worktree block in the active-workflow section
below, which a new request beside an active workflow uses too; run it with the
request in a new args file.
{{/capability}}

```bash
{{#capability commit_surface}}
ARGS_DIR='<directory from step 1>'
{{/capability}}
ROOT_OVERRIDE="$(printenv {{root_env}} || true)"
CLAUDE_PLUGIN_ROOT="${ROOT_OVERRIDE:-${CLAUDE_PLUGIN_ROOT}}"
[ -n "$CLAUDE_PLUGIN_ROOT" ] || CLAUDE_PLUGIN_ROOT="$(find ~/.claude/plugins/cache/agentic-plugins/{{name}} -mindepth 1 -maxdepth 1 -type d 2>/dev/null | grep -E '/(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$' | sort -V | tail -1)"
PERSONA={{name}}
REPO_ROOT="$(git rev-parse --show-toplevel)"
GIT_BRANCH="$(git branch --show-current)"
{{#capability commit_surface}}
START_ARGS="$(node "$CLAUDE_PLUGIN_ROOT/scripts/start-args.mjs" --args-file "$ARGS_DIR/args.json")" || exit $?
# A command substitution drops trailing newlines; the sentinel keeps them.
FEATURE="$(printf '%s' "$START_ARGS" | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>process.stdout.write(JSON.parse(s).feature))'; printf x)"; FEATURE="${FEATURE%x}"
[ -n "$FEATURE" ] || { echo "✗ No feature description was read; nothing was written." >&2; exit 2; }
BASE_BRANCH="$(printf '%s' "$START_ARGS" | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>process.stdout.write(JSON.parse(s).base_branch))')" || exit $?
{{/capability}}
# ACCEPT_CURRENT_TREE=1, exported or set in this block, accepts a dirty tree;
# the flag carries it to the check either way.
case "${ACCEPT_CURRENT_TREE:-}" in 1) ACCEPT_TREE=true ;; *) ACCEPT_TREE=false ;; esac
BASELINE="$(node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" check-clean-baseline --repo-root "$REPO_ROOT" --accept-current-tree "$ACCEPT_TREE")"
BASELINE_RC=$?
if [ "$BASELINE_RC" -ne 0 ]; then
  echo "✗ clean-baseline check failed (exit $BASELINE_RC); its error is above." >&2; exit "$BASELINE_RC"
fi
STATUS="$(printf '%s' "$BASELINE" | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{try{process.stdout.write(JSON.parse(s).status||"")}catch{process.stdout.write("")}})')"
# Fail CLOSED: only an explicit clean/accepted proceeds. A dirty tree, an
# empty status, or any unrecognized value stops the bootstrap — the gate
# must never fail open on a parse error or a non-zero check.
case "$STATUS" in
  clean|accepted) ;;  # proceed
  dirty)
    echo "✗ Working tree not clean — /${PERSONA}:start gates a clean baseline before bootstrapping a deliverable." >&2
{{#capability commit_surface}}
    printf '%s' "$BASELINE" | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>console.log(JSON.stringify(JSON.parse(s).categories,null,2)))' >&2
{{/capability}}
{{#capability commit_surface}}
    # ADR-0067 Decision 8, item 3 — a worktree first: the runtime planner's
    # command for this request, read-only.
    node "$CLAUDE_PLUGIN_ROOT/scripts/discover-runtime.mjs" worktree-plan --repo-root "$REPO_ROOT" \
      --task "$FEATURE" --base "$BASE_BRANCH" --host "${AGENTIC_HOST:-claude}" --format text >&2
{{/capability}}
{{^capability commit_surface}}
    # ADR-0067 Decision 8, item 3 — a worktree first; the request reaches the
    # planner through an args file, never through this block.
    echo "→ Proposed: a new worktree first, which leaves this checkout's changes where they are: run the worktree block (the active-workflow section) with the request in an args file; it prints the git worktree add command." >&2
{{/capability}}
    echo "  Or resolve it here, then re-run:" >&2
    echo "    • clean:  git restore . ; git clean -fd" >&2
    echo "    • stash:  git stash push --include-untracked  (re-run, then git stash pop)" >&2
{{#capability commit_surface}}
    echo "    • accept: set ACCEPT_CURRENT_TREE=1 to sweep the current tree into the workflow's commit (Phase 7 stages all of it)" >&2
{{/capability}}
{{^capability commit_surface}}
    echo "    • accept: set ACCEPT_CURRENT_TREE=1 to acknowledge the dirty tree" >&2
{{/capability}}
    exit 1;;
  *)
    echo "✗ clean-baseline check returned an unrecognized status ('$STATUS') — refusing to bootstrap (fail-closed)." >&2
    exit 1;;
esac
GIT_HEAD="$(git rev-parse HEAD)"
STATUS_DIGEST="$(git status --porcelain=v1 -z --untracked-files=normal | shasum -a 256 | cut -d' ' -f1)"
ACTIVE="$(node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" create \
  --repo-root "$REPO_ROOT" \
  --verb investigate --workflow-type start \
  --host "${AGENTIC_HOST:-claude}" --persona {{name}} \
  --git-baseline-branch "$GIT_BRANCH" --git-baseline-head "$GIT_HEAD" \
  --status-digest "$STATUS_DIGEST" \
{{#capability commit_surface}}
  --original-request "$FEATURE" \
{{/capability}}
{{^capability commit_surface}}
  --original-request "${AGENTIC_TOPIC:-<the original request described above>}" \
{{/capability}}
  --current-phase phase-1-discover \
  --next-action "Run Phase 1 discover+frame+decide composite")" || exit $?
```
