# Codex hooks

Codex CLI loads bundled plugin hooks when the plugin is enabled and generic
`[features].hooks` (default on) is set. The dedicated `plugin_hooks` feature
flag was removed in Codex ~0.134; only legacy Codex 0.130–0.133 required
`[features].plugin_hooks = true` (stage-aware gate per ADR-0030).
The founder Codex manifest exposes `./adapters/codex/hooks/hooks.json`, so
Codex plugin management can show host-specific lifecycle commands without
routing through Claude adapter paths. Automatic execution still depends on the
packaged hook passing Codex `/hooks` review/trust in the active host session.

## Files

- `session-start.mjs` — emits the same `[founder-active-metadata]`
  summary as the Claude SessionStart hook when Codex starts after compact.
- `pre-compact.mjs` — writes `last_snapshot + host_history` with
  `host=codex` before compact.
- `stop.mjs` — runs the same `last_snapshot + host_history` write
  that Claude's automatic Stop hook performs. Skills may still invoke
  this script as a fallback final step on Codex when plugin hooks are
  disabled, not yet trusted, or not active in the current session, e.g.:

  ```bash
  node "${PLUGIN_ROOT}/adapters/codex/hooks/stop.mjs"
  ```

  (Plugin-hook absence is non-fatal per ADR-0011 §4 — the workflow file
  itself is the authoritative state; this manual invocation is the
  Codex-side fallback accelerator.)
- `run-node-hook.sh` — hook-entry wrapper used by `hooks.json` so automatic
  Codex hook execution can find Node from common version-manager locations
  even when the host hook runner does not inherit a login-shell `PATH`.

## Diagnostics

Use `$runtime:doctor` to verify whether the installed Codex CLI reports
generic `hooks` and the `plugin_hooks` stage (`removed` on current Codex),
whether the founder manifest exposes hooks, and
whether the installed plugin cache carries the manifest-declared hook file.
