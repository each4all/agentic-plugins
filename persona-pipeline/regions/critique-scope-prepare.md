### Review scope (document deliverables, C120)

Before the prompt is built, open this critique in the workflow's review
ledger. The block prints the critique's scope as JSON; keep its `ledger` and
`generation` for the close below (ADR-0063, amendment of 2026-10-14).

```bash
ROOT_OVERRIDE="$(printenv {{root_env}} || true)"
CLAUDE_PLUGIN_ROOT="${ROOT_OVERRIDE:-${CLAUDE_PLUGIN_ROOT}}"
[ -n "$CLAUDE_PLUGIN_ROOT" ] || CLAUDE_PLUGIN_ROOT="$(find ~/.claude/plugins/cache/agentic-plugins/{{name}} -mindepth 1 -maxdepth 1 -type d 2>/dev/null | grep -E '/(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$' | sort -V | tail -1)"
# A checkout git cannot read (a broken HEAD) is the script's to judge, and
# it falls back: the block hands it this directory instead of stopping.
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || REPO_ROOT="$PWD"
# A fresh shell: the workflow is found again here, never carried from an
# earlier block. A failure (no workflow found, an older state.mjs without the
# subcommand, a workflow it cannot read) is no reason to stop the critique: it
# runs as it always has.
ACTIVE="$(node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" find-active --repo-root "$REPO_ROOT")"
[ -n "$ACTIVE" ] && node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" critique-scope \
  --workflow-path "$ACTIVE" --repo-root "$REPO_ROOT" \
  --profile '<profile, empty for the default>' \
  || echo '{"recorded": false, "mode": "full", "reason": "critique-scope-failed"}'
```

- `recorded: false`: the critique runs as it always has, and the close below
  is skipped. The deliverable is not a document — code, prose mixed with code
  or a file that is not a regular one, a change inside a fenced block
  (Markdown can execute), nothing changed since the workflow's baseline — or
  the ledger cannot vouch for it: a baseline that names no commit, a checkout
  it cannot read (a conflicted merge, HEAD moving, an index entry marked
  assume-unchanged or skip-worktree), a checkout on another
  branch, or the block's own failure (`reason` says which). A ledger an
  earlier critique of this workflow left is moved aside
  (`ledger_moved_aside`), so refine reads no findings this critique did not
  judge; on another branch it is left alone.
- `mode: full`: review the whole deliverable, as always. The first critique
  of a document is full, and so is every critique whose scope the ledger
  cannot vouch for: an operation in progress, HEAD or the baseline moved, a
  path added or removed, an edit after the last refine record, no refine
  recorded, a last critique with another profile, a target the ledger does
  not hold, an unreadable ledger, a critique since the last one that the
  ledger never recorded (`unrecorded-critique`: every `append --verb
  critique`, a lifecycle's critique phase included, notes a critique-run
  marker, an older release the `Phase 0: Resume into critique` heading, and
  the ledger counts them), or the
  tree the last critique reviewed no longer readable (`reason` names the
  first condition that failed). A full critique never leaves a finding open by scope: every
  CRITICAL and MAJOR it finds is refine's work.
- `mode: partial`: a profile other than the default. Review as that profile
  always has; its close judges only what it reports, resolves no finding it
  does not, leaves nothing open by scope, and is never the full critique a
  scoped one starts from. The `targets` are a refine's that no critique
  has judged yet: judge each one the lens covers; one it does not report
  stays open and stays a target.
- `mode: scoped`: build the prompt from the ensemble protocol's § Scoped
  re-check (Scoped review), and give local reviewers the same scope: the
  `passages` (each changed block's text now, and `before` it), the `targets`
  the last refine aimed at, and the other open `findings` with their ids.
  Review whether each target is resolved and whether the changed passages
  introduced a problem. A problem seen outside the passages is still reported,
  marked outside.
