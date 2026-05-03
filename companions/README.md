# companions/

Bidirectional companion bridges between Claude Code and OpenAI Codex CLI.

## Status

Stage 1 — wire contract drafted; companion script implementations to follow
in subsequent commits of this Stage. See `docs/DEVELOPMENT.md` § Stage 1.

## Contents

- **[`contract.md`](contract.md)** — wire-spec contract that both companions
  implement. Pin-point reference for: invocation surface (CLI subcommand +
  flags), prompt structure (XML vocabulary), output convention (text +
  optional JSON envelope), error semantics (exit codes + named error
  kinds). Versioned independently (current: `v0.1.0`).
- `claude-companion.mjs` — Codex → Claude peer-agent invocation (forthcoming).
  Shells out to the `claude` CLI in headless mode.
- `codex-companion.mjs` — Claude → Codex peer-agent invocation (forthcoming).
  Shells out to the `codex` CLI in headless mode.
- `tests/` — round-trip smoke tests against the real `claude` and `codex`
  CLIs (forthcoming).

## Why companions and not MCP?

Companions are for **peer-agent invocation** — full-turn delegation where
the peer agent uses its own tools and reasoning. MCP is for stateless
atomic tool calls. See [`docs/adr/0003-mcp-vs-companion.md`](../docs/adr/0003-mcp-vs-companion.md).

## Why first-party and not third-party?

To control the contract and avoid third-party version coupling. Both
companions live in this repository, share `contract.md`, and shell out
only to the **public** peer-host CLIs (`claude -p`, `codex exec`). See
[`docs/adr/0004-companion-ownership.md`](../docs/adr/0004-companion-ownership.md)
and § 6 Out of Scope in [`contract.md`](contract.md) for the explicit
non-port boundary against omcc-codex-companion's internal app-server
APIs.
