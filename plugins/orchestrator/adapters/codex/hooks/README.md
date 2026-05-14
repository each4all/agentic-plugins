# Codex hooks

Codex CLI supports bundled plugin hooks behind `[features].plugin_hooks = true`.
The orchestrator Codex manifest exposes `./hooks/hooks.json`, so Codex plugin
management can show the lifecycle hooks packaged by this plugin. Automatic
execution still depends on the active Codex host enabling plugin hooks and the
hook passing Codex review/trust.

## Files

- `stop.mjs` — runs the same `last_snapshot + host_history` write that Claude's automatic Stop hook performs, then evaluates macro auto-archive A1-A4 using the shared orchestrator stop-archive implementation. Skills may invoke this script as a fallback final step on Codex when plugin hooks are disabled, not yet trusted, or not active in the current session, e.g.:

  ```bash
  node "${CLAUDE_PLUGIN_ROOT}/adapters/codex/hooks/stop.mjs"
  ```

  (Plugin-hook absence is non-fatal per ADR-0011 §4 — the workflow file itself is the authoritative state; this manual invocation is the Codex-side fallback accelerator.)

## Diagnostics

- Use `$runtime:doctor` to verify whether the installed Codex CLI reports `hooks` and `plugin_hooks`, whether the orchestrator manifest exposes hooks, and whether the installed plugin cache carries `hooks/hooks.json`.
