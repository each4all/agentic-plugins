### Review ledger close (document deliverables, C120)

When `critique-scope` recorded this critique (`recorded: true`), close it
after the synthesis and before Phase 2, whatever the verdict. Write the
findings with your file-writing tool, not the shell, as `findings.json` in a
new `mktemp -d "${TMPDIR:-/tmp}/agentic-text.XXXXXX"` directory:

```json
{"findings": [
  {"id": "G1-F2", "verdict": "resolved"},
  {"id": "NEW", "severity": "MAJOR", "location": "docs/x.md:12-14",
   "text": "what is wrong and why", "scope": "outside"}
]}
```

Every synthesized finding is there: a new one as `NEW` with its severity
(CRITICAL, MAJOR, MINOR or SUGGESTION), its location as `path:line` or
`path:start-end` in the current text, the path as the artifact set spells
it, its text, and in a scoped critique `scope` `in` or `outside` the passages
(a location in a passage is in, whatever the mark, and a finding with no
location, or one on a path the artifact set does not hold, counts in); a ledger
finding judged again by its id, with `verdict` `resolved` or `unresolved`. In a scoped critique every
target needs one verdict: a target with none, or with two, stays open.

```bash
TEXT_DIR='<directory holding findings.json>'
ROOT_OVERRIDE="$(printenv {{root_env}} || true)"
CLAUDE_PLUGIN_ROOT="${ROOT_OVERRIDE:-${CLAUDE_PLUGIN_ROOT}}"
[ -n "$CLAUDE_PLUGIN_ROOT" ] || CLAUDE_PLUGIN_ROOT="$(find ~/.claude/plugins/cache/agentic-plugins/{{name}} -mindepth 1 -maxdepth 1 -type d 2>/dev/null | grep -E '/(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$' | sort -V | tail -1)"
# A checkout git cannot read (a broken HEAD) is the script's to judge, and
# it falls back: the block hands it this directory instead of stopping.
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || REPO_ROOT="$PWD"
# A fresh shell: the workflow is found again here, never carried from an
# earlier block. A refusal, or no workflow found, records nothing and is no
# reason to stop the critique: the fallback below says so, and the bullets say
# what follows.
ACTIVE="$(node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" find-active --repo-root "$REPO_ROOT")"
[ -n "$ACTIVE" ] && node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" critique-close \
  --workflow-path "$ACTIVE" --repo-root "$REPO_ROOT" \
  --ledger '<ledger from critique-scope>' \
  --generation '<generation from critique-scope>' \
  --findings-file "$TEXT_DIR/findings.json" \
  || echo '{"closed": false, "reason": "critique-close-refused"}'
```

It prints the disposition, which Phase 2 follows:

- The note's `### Findings` gives each finding its ledger id, and a
  `### Critique scope` section states the mode, its reason and the
  generation. Findings in `left_open` go under `### Left open`: new findings
  other than CRITICAL that a scoped critique saw outside the passages, the
  owner's to weigh when the work lands, never refine's.
- `converged: true` (no CRITICAL or MAJOR open in the ledger) puts the
  proposal on the commit route only when nothing else this runbook names
  stands in the way: a `conflict` verdict still ends on its gate first, and a
  persona's own conditions (a veto, a gate verdict, a required re-render)
  still hold. Otherwise refine's work is `carry`, every CRITICAL and MAJOR
  open in the ledger, targeted before or not.
- `closed: false`: the close refused (its error is above) and recorded
  nothing. It refuses when the checkout no longer holds the tree the critique
  reviewed, or the ledger was replaced since the critique opened: run
  `critique-scope` again and review what is there now. A
  finding id the ledger does not hold, or a malformed finding, refuses too;
  fix the file and run the block again. A critique left unclosed counts as a
  full one the ledger did not record: every CRITICAL and MAJOR it found is
  refine's work, nothing is left open by scope, and it never converges by
  the ledger. Until a later critique closes, the ledger vouches for nothing:
  `review-status` reads no ledger, `refine-record` records nothing, and the
  next critique is full.
