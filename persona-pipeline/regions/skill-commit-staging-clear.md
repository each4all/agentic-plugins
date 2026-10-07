If a `staging-set` gate was pending and the user has confirmed the set:

```bash
PERSONA={{name}}
REPO_ROOT="$(git rev-parse --show-toplevel)" || exit 1
ACTIVE="$(node "<plugin-root>/scripts/state.mjs" find-active --repo-root "$REPO_ROOT")" || exit $?
[ -n "$ACTIVE" ] || { echo "✗ No active ${PERSONA} workflow on this branch." >&2; exit 1; }
node "<plugin-root>/scripts/state.mjs" awaiting-owner-clear \
  --workflow-path "$ACTIVE" --host <claude|codex> --gate staging-set \
  --next-action "Commit the confirmed staging set with /${PERSONA}:commit" \
  --next-step-kind commit --next-step-confidence HIGH || exit $?
```

The clear records the owner's resolution with the next step `commit` and its
next action in the same write, so a commit that fails afterwards leaves
neither the `owner-decision` the gate had recorded nor the gate's
`Owner: confirm the staging set …` next action.
