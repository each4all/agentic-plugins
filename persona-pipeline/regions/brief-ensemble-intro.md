The user never invokes the peer host directly. The skill orchestrates
dispatch, collection, and synthesis transparently through
`companions/contract.md` v0.1.1 (Claude → Codex via `codex-companion`,
Codex → Claude via `claude-companion`). When the peer host is not
installed or returns no usable output, the ensemble degrades silently to
local-only.

Mechanics — how to dispatch the peer companion, how to consume its JSON
envelope — live in `plugins/{{persona}}/scripts/peer-runner.mjs` for
command-managed ensembles, with `dispatch-peer.mjs` retained as the
blocking compatibility surface. This protocol describes only the
wire-level contract: what to send, what to expect back, how to synthesize.
