# Codex hooks (manual-invoke helpers)

Codex CLI exposes a host-level hooks feature in current releases, but
agentic-plugins has not verified plugin-local automatic hook packaging
equivalent to Claude Code's plugin `hooks/hooks.json` lifecycle binding.
ADR-0011 §4's "Codex CLI | Stop" hook contract is therefore satisfied
here by **manual invocation** rather than automatic event binding.

## Files

- `stop.mjs` — runs the same `last_snapshot + host_history` write
  that Claude's automatic Stop hook performs. Skills should invoke
  this script as the final step of their command-invoked mode on
  Codex side, e.g.:

  ```bash
  node "${CLAUDE_PLUGIN_ROOT}/adapters/codex/hooks/stop.mjs"
  ```

  (Automatic plugin-local hook binding absence is non-fatal per ADR-0011
  §4 — the workflow file itself is the authoritative state; this manual
  invocation is the Codex-side accelerator.)

## Future work

If a future Codex CLI release ships plugin-local automatic hook
packaging, the manual invocation can be replaced by a hooks manifest
similar to `plugins/engineer/hooks/hooks.json`. The script body itself
does not need to change.
