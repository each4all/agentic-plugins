# Codex hooks (manual-invoke helpers)

As of Codex CLI 0.128.0, **no plugin-local automatic hook packaging has been verified** for orchestrator's lifecycle events (whether Codex CLI exposes a global hook surface that could register this script is a separate user-environment concern). ADR-0011 §4's "Codex CLI | Stop" hook contract is therefore satisfied here by **manual invocation** rather than automatic event binding.

## Files

- `stop.mjs` — runs the same `last_snapshot + host_history` write that Claude's automatic Stop hook performs (snapshot-only in this plan-only MVP; auto-archive ships in a follow-up PR alongside `/orchestrator:done`). Skills should invoke this script as the final step of their command-invoked mode on Codex side, e.g.:

  ```bash
  node "${CLAUDE_PLUGIN_ROOT}/adapters/codex/hooks/stop.mjs"
  ```

  (Hook absence is non-fatal per ADR-0011 §4 — the workflow file itself is the authoritative state; this manual invocation is the Codex-side accelerator.)

## Future work

- If a future Codex CLI release ships plugin-local automatic hook packaging, the manual invocation can be replaced by a hooks manifest similar to `plugins/orchestrator/hooks/hooks.json`. The script body itself does not need to change.
- The auto-archive A1–A4 gate is deferred to a follow-up PR per ADR-0018 §sub-decision-1; when it lands, this script will be extended to mirror `plugins/orchestrator/adapters/claude/hooks/stop.mjs`'s gate evaluation rather than performing snapshot-only writes.
