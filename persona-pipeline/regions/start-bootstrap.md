In the block, replace `<the original request described above>` with a
{{request_placeholder}}; `AGENTIC_TOPIC` takes its place when it is set. The
block sets the repository and branch itself: a shell variable does not outlive
a Bash call.

```bash
ROOT_OVERRIDE="$(printenv {{root_env}} || true)"
CLAUDE_PLUGIN_ROOT="${ROOT_OVERRIDE:-${CLAUDE_PLUGIN_ROOT}}"
[ -n "$CLAUDE_PLUGIN_ROOT" ] || CLAUDE_PLUGIN_ROOT="$(find ~/.claude/plugins/cache/agentic-plugins/{{name}} -mindepth 1 -maxdepth 1 -type d 2>/dev/null | grep -E '/(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$' | sort -V | tail -1)"
PERSONA={{name}}
REPO_ROOT="$(git rev-parse --show-toplevel)"
GIT_BRANCH="$(git branch --show-current)"
BASELINE="$(node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" check-clean-baseline --repo-root "$REPO_ROOT")"
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
    echo "  Resolve, then re-run:" >&2
    echo "    • clean:  git restore . ; git clean -fd" >&2
    echo "    • stash:  git stash push --include-untracked  (re-run, then git stash pop)" >&2
    echo "    • accept: set ACCEPT_CURRENT_TREE=1 to acknowledge the dirty tree" >&2
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
  --original-request "${AGENTIC_TOPIC:-<the original request described above>}" \
  --current-phase phase-1-discover \
  --next-action "Run Phase 1 discover+frame+decide composite")" || exit $?
```
