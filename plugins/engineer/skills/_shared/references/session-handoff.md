# Session-Level Handoff Wiring (engineer, ADR-0031)

This is the engineer-side wiring for the **session-level continue-vs-fresh
preflight** specified in
[`entry-routing-contract.md` § Session-Level Continue-vs-Fresh Preflight](./entry-routing-contract.md).
It is the single source for how an engineer command computes its own bounded
workflow projection and passes it **into** the runtime seam — the runtime
layer never reads engineer state (projection / inversion-of-control model,
preserving the ADR-0010 L3 → L1 direction).

## When to surface it

Per the contract's firing rules, surface the preflight **before guiding the
user toward substantial next work**:

- at **`engineer:start` Phase 0** (before sequencing a fresh lifecycle) — a
  pre-work surface the model still performs, and
- at **standalone verb / lifecycle completion** — **now code-emitted** (ADR-0039):
  the terminal mutation (`state.mjs set-terminal`, and `phase7-commit.mjs` for
  the lifecycle) fires `emitTerminalHandoffSidecar`, which — after writing the
  projection — shells out to the runtime `footer.mjs` and prints the completion
  footer (context state, completion state + next action, workflow id/path,
  artifact pointers, recommended next work, and this continue-vs-fresh
  session-handoff) on the caller's **stderr**. The model does **not** hand-compose
  it at completion; it surfaces the emitted one.

It is not emitted on a trivial reversible step.

## Completion footer is code-emitted (ADR-0039)

The `## How to compute + pass the projection` recipe below is the **contract
reference** and the mechanism the **Phase 0** pre-work preflight uses. At
**completion** the same projection is computed and handed to `footer.mjs`
automatically by `emitTerminalHandoffSidecar` (engineer `session-handoff.mjs`),
via the `discover-runtime.mjs` resolver (copy-not-import, ADR-0010 §5). That
render is:

- **stderr only, never stdout** (the completion scripts' stdout is a load-bearing
  machine channel);
- **fail-closed silent** — a missing/too-old runtime (below
  `MIN_RUNTIME_VERSION`) emits nothing and never throws; the completion proceeds
  and the `SessionStart` backstop still re-surfaces the pending handoff;
- **idempotent** — rendered at most once per terminal transition (a sibling
  marker keyed to `workflow_id` makes the Stop-hook backstop a no-op once the
  primary rendered), and a rendered footer suppresses the false "missed-footer"
  `SessionStart` nudge.

## How to compute + pass the projection

The engineer projection is computed **fail-closed** by a read-only script that
uses the **pure** `evaluateStopArchive` evaluator (never the side-effecting
`runStopArchive` runner), so computing it has no side effects:

```bash
# 1. Compute the bounded projection from engineer's OWN state.
HANDOFF="$(node "$CLAUDE_PLUGIN_ROOT/scripts/session-handoff.mjs" project \
  --repo-root "$REPO_ROOT" --routing "/engineer:resume")"
STATUS="$(echo "$HANDOFF" | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{try{process.stdout.write(JSON.parse(s).status||"")}catch{}})')"
# Routing is always present in the result (ADR-0031 input (c)) — pass it
# standalone when there is no projection so the seam never loses it.
ROUTING="$(echo "$HANDOFF" | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{try{process.stdout.write(JSON.parse(s).routing||"")}catch{}})')"

case "$STATUS" in
  ok)
    # 2. Materialize just the projection object to a temp file and pass it to
    #    the runtime seam. runtime composes context-risk × archive_gate into
    #    the continue-vs-fresh decision + next-session prompt/command.
    PROJ_FILE="$(mktemp -t engineer-projection.XXXXXX).json"
    echo "$HANDOFF" | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{process.stdout.write(JSON.stringify(JSON.parse(s).projection))})' > "$PROJ_FILE"
    # The runtime footer/check is advisory + pointer-only; --risk is the
    # caller-supplied context-budget risk (host-measured tokens are not
    # available — ADR-0031 §7). Use the runtime footer helper when present:
    #   runtime:context check --risk <green|yellow|red> --workflow-projection-file "$PROJ_FILE"
    #   runtime footer --workflow-projection-file "$PROJ_FILE" ...
    ;;
  no_active_branch_context)
    # Detached HEAD — report it, do NOT auto-recommend a fresh session
    # (ADR-0018 §sub-2). Surface: "no active branch context".
    ;;
  no_active_workflow|fail_closed)
    # No active engineer workflow, or a corrupt / ambiguous (canonical+legacy
    # split) state. Degrade: NO projection, but routing is still available —
    # pass it standalone so the seam keeps the routing-shaped next command:
    #   runtime:context check --risk <green|yellow|red> --routing-recommendation "$ROUTING"
    # Surface the reason from the handoff result.
    ;;
esac
```

The projection schema (workflow_kind, workflow_id, workflow_path, phase,
next_action, checkpoint, archive_gate, routing_recommendation) and its
fail-closed rules are owned by the contract section linked above; this wiring
just produces a schema-valid projection and hands it to the seam.

## Boundaries

- **Read-only / non-mutating.** `session-handoff.mjs` only reads engineer state
  and runs the pure evaluator; it never archives, marks terminal, or mutates
  the workflow. The runtime footer it feeds is advisory and pointer-only.
- **Fail-closed.** A corrupt or ambiguous engineer state yields no projection;
  the seam degrades to context-risk + routing rather than trusting a partial
  projection.
- **No auto-fresh on detached HEAD.** Report "no active branch context"; do not
  recommend a fresh session from a state with no branch to anchor to.
