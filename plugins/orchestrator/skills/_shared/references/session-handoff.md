# Session-Level Handoff Wiring (orchestrator, ADR-0031)

This is the orchestrator-side wiring for the **session-level continue-vs-fresh
preflight**. Its **canonical contract** — the firing rules, the three inputs,
the bounded projection schema, and the continue-vs-fresh decision policy — is
the `entry-routing-contract.md § Session-Level Continue-vs-Fresh Preflight
(ADR-0031)` section in the engineer plugin (the single source; ADR-0010 §5
forbids a cross-plugin import, so this file points to that contract by name
rather than restating its schema, which would drift). This file is the
orchestrator-local single source for how an orchestrator **macro** surface
computes its own bounded projection and passes it **into** the runtime seam —
the runtime layer (L1) never reads orchestrator (L2) state, preserving the
ADR-0010 L2 → L1 direction (projection / inversion-of-control model).

## When to surface it

Per the contract's firing rules, surface the preflight at the **macro-level
equivalents of verb completion** — before guiding the user toward substantial
next work:

- at **`orchestrator:next` dispatch completion** (after the dispatch summary), and
- at **`orchestrator:plan` / `orchestrator:finalize` / `orchestrator:abort`
  completion** (alongside the runtime completion footer), and
- whenever the caller-supplied **context risk is yellow/red** (continuing a
  near-full session is the case the handoff exists to catch).

It is not emitted on a trivial reversible step.

## How to compute + pass the projection

The orchestrator macro projection is computed **fail-closed** by a read-only
script that uses the **pure** `evaluateMacroStopArchive` evaluator (never the
side-effecting `runMacroStopArchive` runner), so computing it has no side
effects. The macro is resolved **across branches** — `find-active` on the
macro's own branch, then `find-macro` on a subtask branch — never `find-active`
alone on a subtask branch (it keys on the macro's own `git_baseline.branch` and
would miss the parent):

```bash
# 1. Compute the bounded macro projection from orchestrator's OWN state.
#    --routing is the macro's resolved next route (e.g. /orchestrator:next to
#    dispatch the next ready subtask, else /orchestrator:resume).
HANDOFF="$(node "$CLAUDE_PLUGIN_ROOT/scripts/session-handoff.mjs" project \
  --repo-root "$REPO_ROOT" --routing "/orchestrator:next")"
STATUS="$(echo "$HANDOFF" | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{try{process.stdout.write(JSON.parse(s).status||"")}catch{}})')"
# Routing is always present in the result (ADR-0031 input (c)) — pass it
# standalone when there is no projection so the seam never loses it.
ROUTING="$(echo "$HANDOFF" | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{try{process.stdout.write(JSON.parse(s).routing||"")}catch{}})')"

case "$STATUS" in
  ok)
    # 2. Materialize just the projection object to a temp file and pass it to
    #    the runtime seam. runtime composes context-risk × archive_gate into
    #    the continue-vs-fresh decision + next-session prompt/command.
    PROJ_FILE="$(mktemp -t orchestrator-projection.XXXXXX).json"
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
    # No active macro on this branch, or a corrupt / ambiguous (canonical+legacy
    # split, or one subtask branch matching 2+ macros) state. Degrade: NO
    # projection, but routing is still available — pass it standalone so the
    # seam keeps the routing-shaped next command:
    #   runtime:context check --risk <green|yellow|red> --routing-recommendation "$ROUTING"
    # Surface the reason from the handoff result.
    ;;
esac
```

The projection schema (workflow_kind=`orchestrator`, workflow_id, workflow_path,
phase, next_action, checkpoint, archive_gate, routing_recommendation) and its
fail-closed rules are owned by the canonical contract named above; this wiring
just produces a schema-valid macro projection and hands it to the seam.

## Codex hook parity (diagnose + operator attestation only)

The preflight itself fires **synchronously at completion** and is fully
host-symmetric: a Codex `$orchestrator:{next,plan,finalize,abort}` skill
computes and passes the macro projection exactly as the Claude command does.

What is **not** non-interactively provable on Codex is the *re-surfacing* of the
emitted next-session prompt in a later session: that re-injection rides the
SessionStart hook, which on Codex additionally requires `[features].plugin_hooks
= true` plus a `/hooks` review/trust of the packaged hook. agentic-plugins
cannot prove that trust state from a headless run (settings.mjs:955) — so this
is **diagnose + operator attestation only**:

- diagnose readiness with `runtime:doctor` (Codex plugin-hook readiness) and
  plan/attest with `runtime:settings` (`--apply-codex-plugin-hooks`,
  `--attest-codex-hook-review`);
- the durable handoff (the `runtime:context` artifact's next-session field)
  is host-shared and survives regardless — only its automatic re-injection
  depends on the attested Codex hook state.

This is the honest-scope boundary (ADR-0001 §5): the preflight computes and
reports identically on both hosts; only Codex auto-re-injection is gated on an
operator-attested hook trust the framework does not silently assume.

## Boundaries

- **Read-only / non-mutating.** `session-handoff.mjs` only reads orchestrator
  state and runs the pure evaluator; it never archives, marks terminal, or
  mutates the macro. The runtime footer it feeds is advisory and pointer-only.
- **Fail-closed.** A corrupt or ambiguous macro state (canonical+legacy
  duplicates, or one subtask branch matching 2+ macros) yields no projection;
  the seam degrades to context-risk + routing rather than trusting a partial
  projection.
- **Macro resolution, not subtask.** Resolve the macro via `find-active` then
  `find-macro`; a completing surface projects the **macro** workflow only. An
  engineer verb on a subtask branch projects the engineer workflow at its own
  completion — the two are never merged (one projection per surface).
- **HEAD-independent readiness.** Macro `archive_gate` comes from the pure
  `evaluateMacroStopArchive` gates (terminal_marker + macro_terminal_phase +
  all_subtasks_terminal + no_active_engineer_children); it never probes git
  HEAD, because a macro spans branches and HEAD comparison is meaningless.
- **No auto-fresh on detached HEAD.** Report "no active branch context"; do not
  recommend a fresh session from a state with no branch to anchor to.
