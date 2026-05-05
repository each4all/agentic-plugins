# Codex hooks (manual-invoke helpers)

Codex CLI does not expose a hook event surface equivalent to Claude
Code's `PreCompact` / `Stop` / `SessionStart` (as of Codex CLI
0.128.0). ADR-0011 §4's "Codex CLI | Stop" hook contract is therefore
satisfied here by **manual invocation** rather than automatic event
binding.

## Files

- `stop.mjs` — runs the same `last_snapshot + host_history` write
  that Claude's automatic Stop hook performs. Skills should invoke
  this script as the final step of their command-invoked mode on
  Codex side, e.g.:

  ```bash
  node "${CLAUDE_PLUGIN_ROOT}/adapters/codex/hooks/stop.mjs"
  ```

  (Hook absence is non-fatal per ADR-0011 §4 — the workflow file
  itself is the authoritative state; this manual invocation is the
  Codex-side accelerator.)

## Future work

If a future Codex CLI release exposes session-lifecycle events, the
manual invocation can be replaced by a hooks manifest similar to
`plugins/engineer/hooks/hooks.json`. The script body itself does not
need to change.
