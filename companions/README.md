# companions/

Bidirectional companion bridges between Claude Code and OpenAI Codex CLI.

## Status

**Stub.** No implementation yet. To be built in Stage 1 of the
development plan (`docs/DEVELOPMENT.md`).

## Planned contents

- `contract.md` — XML prompt structure + output parsing spec, shared by both companions
- `claude-companion.mjs` — Codex → Claude peer-agent invocation. Shells out to the `claude` CLI in headless mode
- `codex-companion.mjs` — Claude → Codex peer-agent invocation. Shells out to the `codex` CLI
- `tests/` — Round-trip smoke tests that invoke real `claude` and `codex` CLIs in CI

## Why companions and not MCP?

Companions are for **peer-agent invocation** — full-turn delegation
where the peer agent uses its own tools and reasoning. MCP is for
stateless atomic tool calls. See `docs/adr/0003-mcp-vs-companion.md`.

## Why first-party and not third-party?

To control the contract and avoid third-party version coupling. See
`docs/adr/0004-companion-ownership.md`.
