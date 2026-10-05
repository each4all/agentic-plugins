| Operation | Claude | Codex |
|-----------|--------|-------|
| `state.mjs checkpoint-set` (write `latest_checkpoint`) | `--host claude` | `--host codex` — same on-disk schema; the host flag distinguishes write provenance in `host_history` |
| Schema preservation (schema 1 keeps 1; '1.1' keeps '1.1') | Yes | Yes — `state.mjs` is host-agnostic |
| SessionStart re-injection of the summary — both hosts register the hook with `matcher: "compact"`, so this is **post-compact only**, never an arbitrary new session | Yes — the hook surfaces `[{{persona}}-active-metadata]` with the checkpoint summary + timestamp after compact | Yes when the {{persona}} plugin's hooks are enabled (`[features].hooks`, default on) and `/hooks`-reviewed/trusted; otherwise manual `${{persona}}:resume` reads the same durable checkpoint |

The Codex use case is **cross-host handoff**: a checkpoint written on Codex is
re-injected on either host's next post-compact session, given that host's
hook is live — on Codex that means the plugin's hooks enabled and
`/hooks`-trusted. Without
that active-session trust, Codex can still durably *write* the checkpoint
and `${{persona}}:resume` reads it manually. (Per ADR-0030/0035 the Codex hook
model is generic `[features].hooks` + `/hooks` review/trust — there is no
`plugin_hooks` settings key.)
