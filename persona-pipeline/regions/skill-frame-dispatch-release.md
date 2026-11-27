Then, once the synthesis has read the run's result (the run ledger keeps the
peer's answer, at the result's `stdout_path`), or its `prompt.xml.err` when
no run launched, release the dispatch's
directory with this block where nothing else does, a run launched or not: the
dispatch stopped with no active workflow, or this skill ran on its own (as
`$designer:frame` on Codex does). Under `/designer:frame` its finalize
releases the directory (its `DISPATCH_TEXT_DIR`), and inside a `start`
lifecycle the attempt release block after the phase's settle does: skip this
block there (ADR-0059 Decision 10).

```bash
DISPATCH_TEXT_DIR='<the directory the make printed>'
case "$DISPATCH_TEXT_DIR" in
  ''|'<'*) echo "✗ DISPATCH_TEXT_DIR is empty or not filled in; nothing was released." >&2; exit 1 ;;
esac
# ADR-0059 Decision 10, item 1 — the synthesis has read the run's result: no
# block, rerun or continuation reads the directory again.
RELEASE_PATH="$DISPATCH_TEXT_DIR"
{{> tmpdir-release-skill}}
```
