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
# A fresh shell: the workflow is found again here, never carried from an
# earlier block.
PERSONA={{name}}
REPO_ROOT="$(git rev-parse --show-toplevel)" || exit 1
ACTIVE="$(node "<plugin-root>/scripts/state.mjs" find-active --repo-root "$REPO_ROOT")" || exit $?
[ -n "$ACTIVE" ] || { echo "✗ No active ${PERSONA} workflow on this branch." >&2; exit 1; }
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

**Cross-Bash-call note**: shell-variable state does not survive across Bash
tool invocations, so the block carries nothing from Phase 1: it finds the
active workflow again itself, and `TEXT_DIR` is the directory you set in it.
