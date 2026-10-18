### Review scope (document deliverables, C120)

Before the fix, read the workflow's review ledger (ADR-0063, amendment of
2026-10-14):

```bash
ROOT_OVERRIDE="$(printenv {{root_env}} || true)"
CLAUDE_PLUGIN_ROOT="${ROOT_OVERRIDE:-${CLAUDE_PLUGIN_ROOT}}"
[ -n "$CLAUDE_PLUGIN_ROOT" ] || CLAUDE_PLUGIN_ROOT="$(find ~/.claude/plugins/cache/agentic-plugins/{{name}} -mindepth 1 -maxdepth 1 -type d 2>/dev/null | grep -E '/(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$' | sort -V | tail -1)"
# A fresh shell: the workflow is found again here, never carried from an
# earlier block. A failure (no workflow found, an older state.mjs without the
# subcommand) is no reason to stop the refine: it runs as it always has.
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || REPO_ROOT="$PWD"
ACTIVE="$(node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" find-active --repo-root "$REPO_ROOT")"
[ -n "$ACTIVE" ] && node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" review-status \
  --workflow-path "$ACTIVE" \
  || echo '{"ledger": false, "reason": "review-status-failed"}'
```

- `ledger: false`: no critique of this workflow recorded a document
  deliverable, the ledger cannot be read, the last critique never closed, or
  a critique ran that the ledger never recorded (`reason` says which), so this refine runs as it always has, and the
  recurring rule below is judged as before. Skip the record block too.
- Otherwise refine's work is `carry`, every CRITICAL and MAJOR open in the
  ledger, targeted before or not (and, interactively, the MINOR and
  SUGGESTION findings the user picks). `left_open` findings are the owner's,
  not refine's. A finding is recurring exactly when it is in `recurring`: a
  refine already targeted it and a critique closed since judged it
  unresolved. One in
  `recurring` ends this refine on the `recurring-finding` gate before any fix
  (Phase 2's owner-decision form), unless the owner already ruled on it: when
  an `Owner gate resolved: recurring-finding` note with the owner's Fix now
  was written after the last critique's notes, fix those findings in this
  refine (the owner made the call; the ledger still lists them until a
  critique judges the fix). Notes written after the resolution that record no
  critique, such as `Phase 0: Resume into refine`, leave the ruling standing.
  A finding in text no refine targeted is not recurring, however much it
  resembles an earlier one.

After the fix and its checks, before Refine-verify, record what this refine
targeted: write `targets.txt`, one ledger id per line (the findings it fixed),
with your file-writing tool in a new `mktemp -d
"${TMPDIR:-/tmp}/agentic-text.XXXXXX"` directory, then run the block. Run it
again after any later edit in this refine: the next critique is scoped only
while the checkout holds the tree the last record saw.

```bash
TEXT_DIR='<directory holding targets.txt>'
ROOT_OVERRIDE="$(printenv {{root_env}} || true)"
CLAUDE_PLUGIN_ROOT="${ROOT_OVERRIDE:-${CLAUDE_PLUGIN_ROOT}}"
[ -n "$CLAUDE_PLUGIN_ROOT" ] || CLAUDE_PLUGIN_ROOT="$(find ~/.claude/plugins/cache/agentic-plugins/{{name}} -mindepth 1 -maxdepth 1 -type d 2>/dev/null | grep -E '/(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$' | sort -V | tail -1)"
# A checkout git cannot read (a broken HEAD) is the script's to judge, and
# it falls back: the block hands it this directory instead of stopping.
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || REPO_ROOT="$PWD"
# A fresh shell: the workflow is found again here. A failure, or no workflow
# found, records nothing for this tree; a targets file it refuses (an id the
# ledger does not hold) is fixed and the block run again.
ACTIVE="$(node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" find-active --repo-root "$REPO_ROOT")"
[ -n "$ACTIVE" ] && node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" refine-record \
  --workflow-path "$ACTIVE" --repo-root "$REPO_ROOT" \
  --targets-file "$TEXT_DIR/targets.txt" \
  || echo '{"recorded": false, "reason": "refine-record-failed", "verify": {"mode": "full", "reason": "refine-record-failed"}}'
```

Refine-verify follows the record's `verify`. With `verify.mode: scoped`,
build its prompt from the ensemble protocol's § Scoped re-check (Scoped
refine-verify), the targets with their text and the patch, and the peer
judges whether each target is resolved and whether the patch regressed the
passages it touched. Otherwise (`full`, no record, or no ledger) build it
from § Refine-verify, as always: the ledger cannot vouch for a scoped check
of this tree (`verify.reason` says why). A record that failed leaves the next
critique full, unless an earlier record of this refine saw the same tree.
