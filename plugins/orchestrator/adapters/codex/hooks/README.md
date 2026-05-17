# Codex hooks

Codex CLI supports bundled plugin hooks behind `[features].plugin_hooks = true`.
The orchestrator Codex manifest exposes `./adapters/codex/hooks/hooks.json`,
so Codex plugin management can show host-specific lifecycle commands without
routing through Claude adapter paths. Automatic execution still depends on the
active Codex host enabling plugin hooks and the hook passing Codex review/trust.

## Files

- `session-start.mjs` — emits the same `[orchestrator-active-metadata]`
  summary as the Claude SessionStart hook when Codex starts after compact.
- `pre-compact.mjs` — writes `last_snapshot + host_history` with
  `host=codex` before compact.
- `stop.mjs` — runs the same `last_snapshot + host_history` write that Claude's automatic Stop hook performs, then evaluates macro auto-archive A1-A4 using the shared orchestrator stop-archive implementation. Skills may invoke this script as a fallback final step on Codex when plugin hooks are disabled, not yet trusted, or not active in the current session, e.g.:

  ```bash
  node "${PLUGIN_ROOT}/adapters/codex/hooks/stop.mjs"
  ```

  (Plugin-hook absence is non-fatal per ADR-0011 §4 — the workflow file itself is the authoritative state; this manual invocation is the Codex-side fallback accelerator.)
- `run-node-hook.sh` — hook-entry wrapper used by `hooks.json` so automatic Codex hook execution can find Node from common version-manager locations even when the host hook runner does not inherit a login-shell `PATH`.

## Diagnostics

- Use `$runtime:doctor` to verify whether the installed Codex CLI reports `hooks` and `plugin_hooks`, whether the orchestrator manifest exposes hooks, and whether the installed plugin cache carries the manifest-declared hook file.
