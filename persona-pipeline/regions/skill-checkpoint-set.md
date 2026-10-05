```bash
node "<plugin-root>/scripts/state.mjs" checkpoint-set \
  --workflow-path "$ACTIVE" --host <claude|codex> --summary "$SUMMARY"
```

The CLI is signal-safe (atomic write under the per-file lock) and
schema-preserving (`latest_checkpoint` is a schema-1.1 additive field that
1.0 readers tolerantly ignore; `host_history` gains a `{host, at, event:
checkpointed}` entry per ADR-0011 §1).

Pass `$SUMMARY` as a single quoted argument so embedded whitespace and
special characters survive intact. The CLI rejects empty summaries; Phase 0
already filtered that case.

**Cross-Bash-call note**: shell-variable state (`$ACTIVE`, `$SUMMARY`) does
not survive across Bash tool invocations. If Phase 1 and Phase 2 run in
separate Bash calls, re-resolve both values inside the second call — or
combine them in a single Bash call.
