Phase 0 host-side bootstrap (argument intake, detached-HEAD guard,
clean-baseline gate, active-workflow branching) is owned by the entry path:
`commands/start.md` carries the canonical bash on the Claude side. Direct
`${{persona}}:start` on Codex follows the equivalent operational sequence
inline using the same `scripts/state.mjs` CLI (the state writer is
host-agnostic).

**Active-workflow branching** (both hosts): when `find-active` returns a
non-empty workflow, read its `workflow_type` before continuing. Resume into
the lifecycle only when `workflow_type == start`; when it is a single-verb
`verb-chain` workflow, **reject** — `start` must not absorb a single-verb
workflow into lifecycle phase space. The user finishes or archives it
(`/{{persona}}:resume`) or continues it with the matching `/{{persona}}:<verb>`
first. The **clean-baseline gate** fails closed: only an explicit
`clean` / `accepted` status proceeds; a non-zero check, a `dirty` tree, or an
unparseable status stops the bootstrap.

The **clean-baseline gate** runs on the bootstrap branch (when `find-active`
returns empty and a new workflow is about to be created) before `state.mjs
create`. It calls `state.mjs check-clean-baseline --repo-root <root>` and
inspects the returned `status` (`clean` / `dirty` / `accepted`). On `dirty`
the gate refuses to bootstrap and presents resolutions: clean the tree,
stash, or set `ACCEPT_CURRENT_TREE=1` to acknowledge the dirty tree.
`.agentic-plugins/state/**` is excluded from the dirty check.

**Inside the lifecycle** (both hosts, ADR-0066 PC2b): Phase 0 runs
`state.mjs autopilot-preflight` once, before any write, and a resumed start
workflow clears the next step it carried. Each phase's ensemble attempt is
settled from its run ledger (`peer-runner.mjs settle`) before the next phase,
a repeated phase under a new run id. No phase makes a verb's terminal write;
the lifecycle's one terminal write is `finish-verb` at the end, once it
converged where the persona waits for convergence. An owner gate met in a
phase (a decide CONFLICT, a recurring finding) is recorded with
`state.mjs awaiting-owner-set`, which leaves the workflow open; the lifecycle
pauses, and continues at the next phase once the owner's decision clears it
(`state.mjs awaiting-owner-clear` with that phase as the next step).
