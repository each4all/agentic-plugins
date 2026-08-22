# companions/

Bidirectional companion bridges between Claude Code and OpenAI Codex CLI.

## Status

Stage 1 companion layer complete: contract `v0.1.1` (amended from
v0.1.0 per ADR-0009) plus both implementations shipped (PRs #1, #2,
#3 merged on main). See `docs/DEVELOPMENT.md` § Stage 1 for the
broader Stage 1 scope.

## Contents

- **[`contract.md`](contract.md)** — wire-spec contract that both companions
  implement. Pin-point reference for: invocation surface (CLI subcommand +
  flags), prompt structure (XML vocabulary), output convention (text +
  optional JSON envelope), error semantics (exit codes + named error
  kinds). Versioned independently (current: `v0.1.1`).
- **[`claude-companion.mjs`](claude-companion.mjs)** — Codex → Claude peer-agent
  invocation. Shells out to the public `claude -p` CLI.
- **[`codex-companion.mjs`](codex-companion.mjs)** — Claude → Codex peer-agent
  invocation. Shells out to the public `codex exec` CLI.
- **[`tests/`](tests/)** — hermetic unit tests (`*.test.mjs`, mocked spawn) plus
  env-gated smoke tests (`*.smoke.mjs`) against the real peer CLIs. Smoke tests
  use the `*.smoke.mjs` name (outside Node's default discovery) so `npm test`
  never runs them; invoke them explicitly via `npm run test:smoke` (ADR-0033).

## Which companion to invoke

The companion is named after the **peer it reaches**, not the caller:

| If your plugin runs under | …and wants to invoke | …shell out to |
|---|---|---|
| Claude Code | Codex CLI | `companions/codex-companion.mjs` |
| Codex CLI | Claude Code | `companions/claude-companion.mjs` |

## Quickstart

Both scripts have `#!/usr/bin/env node` shebangs and are mode `0755`.
Invoke with the prompt on stdin (Decision 3 — stdin-only delivery):

```bash
# Claude → Codex (text mode)
echo '<task>Reply OK</task>' | companions/codex-companion.mjs task

# Claude → Codex (JSON envelope)
echo '<task>Reply OK</task>' | companions/codex-companion.mjs task --output-format json

# Codex → Claude (text mode)
echo '<task>Reply OK</task>' | companions/claude-companion.mjs task

# Codex → Claude (JSON envelope)
echo '<task>Reply OK</task>' | companions/claude-companion.mjs task --output-format json
```

Both directions use the same `task` subcommand, prompt-input
precedence, JSON envelope option, and exit-code contract. Both scripts
honor the five pinned options from contract § 2.2: `--prompt-file`,
`--model`, `--effort`, `--cwd`, `--output-format`. Exit codes follow
contract § 5.1 (`0` success, `1` peer run error, `2` companion misuse,
`3` peer infra error).

## Tests

```bash
# Hermetic unit tests (mocked spawn, no network, fast)
node --test companions/tests/claude-companion.test.mjs
node --test companions/tests/codex-companion.test.mjs

# Env-gated smoke tests against real peer CLIs (require auth + network)
COMPANIONS_SMOKE=1 node --test companions/tests/claude-companion.smoke.mjs
COMPANIONS_SMOKE=1 node --test companions/tests/codex-companion.smoke.mjs
```

## Nested peer invocation guard

A peer run is a full agent turn, and that agent can run shell commands —
including the *other* companion. Nothing in the wire contract stops
`claude → codex-companion → codex → claude-companion → claude → …` from
recursing; that bound would otherwise be accidental. Measured 2026-08-22
(claude 2.1.239 / codex-cli 0.148.0): `codex → claude-companion → claude`
already completed a nested round trip in the lab, and `claude → codex →
claude-companion` spawned the nested `claude -p` and was stopped only by
the codex sandbox's network. None of the 168 recorded peer runs on this
machine had ever executed a nested companion — the prompts have not
triggered it, but nothing prevented it.

Both companions carry a **cooperative** guard (companion-internal — no
contract-surface change; contract § 2.4 still holds, nothing is *required*
in the environment):

- Every companion stamps the peer CLI it spawns with
  `AGENTIC_COMPANION_DEPTH=<depth+1>`.
- A companion that starts with `AGENTIC_COMPANION_DEPTH` already at or above
  `AGENTIC_COMPANION_MAX_DEPTH` (default **1** — one peer hop) **refuses
  before reading the prompt** and spawns nothing. It emits the existing
  contract § 5.3 row `companion_error` / exit `3` / `peer_invocation_error`
  (text mode: empty stdout + the one-line stderr summary; JSON mode: the
  envelope, no `metadata` because the peer never ran).
- A marker that is present but not a canonical non-negative integer is
  treated as nested (**fail closed**). A malformed
  `AGENTIC_COMPANION_MAX_DEPTH` falls back to the default bound — a typo
  never widens the guard.

### Deliberately widening or disabling it

`AGENTIC_COMPANION_MAX_DEPTH`, set in the **outermost** caller's
environment, propagates with the marker and raises the allowed depth
(`=2` permits one extra hop); `=0` refuses even a top-level call (a
dispatch kill-switch).

### This is not a security boundary

It is cooperative recursion protection. A wrapper that strips or rewrites
the environment defeats the marker — a documented limit, not a hidden one.
On the codex side the marker is delivered to the peer's shell tools via a
`-c shell_environment_policy.set.AGENTIC_COMPANION_DEPTH=…` config override
(codex does not forward arbitrary parent env to its shell tools); a
measured side effect of that override is that codex's `-c` handling drops a
config-file `shell_environment_policy.inherit` back to its built-in default
for that one peer call, which *widens* (never narrows) the env the codex
peer's own shell tools inherit. See the block comment in
[`codex-companion.mjs`](codex-companion.mjs) for the measurement.

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
