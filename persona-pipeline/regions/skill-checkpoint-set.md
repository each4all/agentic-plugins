The summary reaches `state.mjs` as a file, never on the command line: it is
the text the user typed, and in shell source a quote, `$` or backtick of it
would be read as code (ADR-0059, amendment of 2026-10-10). Before the block:

1. Create a private directory for it, and note the path it prints:

   ```bash
   mktemp -d "${TMPDIR:-/tmp}/agentic-text.XXXXXX"
   ```

2. With your file-writing tool, not the shell, create `summary.txt` in that
   directory holding the summary from Phase 0, ending with one newline.
   Nothing deletes it.

Then run the block with `TEXT_DIR` set to that directory.

```bash
TEXT_DIR='<directory from step 1>'
node "<plugin-root>/scripts/state.mjs" checkpoint-set \
  --workflow-path "$ACTIVE" --host <claude|codex> --summary-file "$TEXT_DIR/summary.txt"
```

The CLI is signal-safe (atomic write under the per-file lock) and
schema-preserving (`latest_checkpoint` is a schema-1.1 additive field that
1.0 readers tolerantly ignore; `host_history` gains a `{host, at, event:
checkpointed}` entry per ADR-0011 §1).

The file carries embedded whitespace and special characters intact, since no
shell reads it. The CLI rejects an empty summary, and a missing file; Phase 0
already filtered the empty case.

**Cross-Bash-call note**: shell-variable state (`$ACTIVE`, `$TEXT_DIR`) does
not survive across Bash tool invocations. If Phase 1 and Phase 2 run in
separate Bash calls, re-resolve both values inside the second call — or
combine them in a single Bash call.
