Direction is symmetric:

| Orchestrator | Peer        | Peer invocation                                                |
|--------------|-------------|----------------------------------------------------------------|
| Claude Code  | Codex CLI   | `codex-companion` (resolved via `companions` plugin discovery) |
| Codex CLI    | Claude Code | `claude-companion` (resolved via `companions` plugin discovery)|

Both companion CLIs ship in the agentic-plugins `companions` plugin and
implement `companions/contract.md` v0.1.1. The contract exposes a single
subcommand `task --prompt-file <path>` accepting an XML prompt. {{persona}}
expresses every ensemble point type as a `task` invocation with a
type-specific prompt template; review-style ensembles embed the review
semantics in the prompt itself rather than relying on separate
subcommands.

The orchestrator is the currently-invoking host; the peer is the other
host. Skills never hard-code one side or the other — they refer to
*orchestrator* and *peer*. Discovery + dispatch mechanics live in
`../../../../scripts/peer-runner.mjs` (the managed runner for
command-runbook ensembles), with `../../../../scripts/dispatch-peer.mjs`
retained as the blocking compatibility surface. On discovery failure the
dispatch is skipped silently per *Failure Handling* below.
