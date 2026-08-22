# Session-Level Handoff Wiring (founder, ADR-0031 + ADR-0043 S3)

This is the founder-side wiring for the **session-level continue-vs-fresh
preflight** (ADR-0031) and the **code-emitted completion footer**
(ADR-0039, enabled for founder by ADR-0043). The **canonical contracts** —
the firing rules, the three inputs, the bounded projection schema, and the
continue-vs-fresh decision policy — live in the engineer plugin's
`entry-routing-contract.md § Session-Level Continue-vs-Fresh Preflight
(ADR-0031)` (the single source, cited by name per ADR-0010 §5; restating
the schema here would drift). The completion-flag minimum content is owned
by the runtime's `docs/completion-output-contract.md`. This file holds only
the founder-local wiring: how a founder surface computes its own bounded
projection, passes it **into** the runtime seam (L3 → L1; the runtime never
reads founder state), and what the code-emitted terminal path guarantees.

## When it fires

- at **standalone verb / lifecycle completion** — **code-emitted**
  (ADR-0039 via ADR-0043 S3): the terminal mutation (`state.mjs
  set-terminal`, the production completion entry point for the six verb
  commands and the `/founder:start` terminal step) fires
  `emitTerminalHandoffSidecar`, which — after writing the projection —
  shells out to the runtime `footer.mjs` and prints the completion footer
  (context state, completion state + next action, workflow id/path,
  artifact pointers, recommended next work, and the continue-vs-fresh
  session-handoff) on the caller's **stderr**. The model does **not**
  hand-compose it at completion; it surfaces the emitted one.
- from the **Stop hook backstop** — if the active workflow is terminal,
  the hook (both hosts) re-fires the sidecar **before** the auto-archive
  move, so the guaranteed-channel projection exists even when the primary
  emit was missed. The idempotency marker makes this a no-op when the
  primary already rendered.
- at **SessionStart (matcher: compact)** — the hook re-surfaces a pending
  handoff **once** and consumes the one-shot file. This runs independently
  of an active workflow (the handoff is typically from a now-archived
  workflow). Inherited matcher consequence: a pending handoff written just
  before a session ends is consumed on the next *compaction* start, not an
  ordinary fresh startup; widening the matcher is ADR-0045 (macro S6)
  entry-time work, not this wiring.

It is not emitted on a trivial reversible step.

## Archive timing — Claude same-turn Stop vs Codex

`state.mjs set-terminal --terminal-marker true` is **not** a deferred marker on
Claude. The Stop hook fires at **every turn end**, so the archive gates — terminal
marker, terminal phase, HEAD movement, no active children — are evaluated at the
end of **that same turn**, not when the session closes. If they all pass the
founder workflow is archived then; if any fails it stays marked and a later Stop
re-evaluates it. Same-turn *evaluation* is the guarantee; same-turn *archival* is
not, and the move itself is best-effort and non-fatal.

No parent writeback fires here at all: founder carries no orchestrator parent
and the step is removed outright (ADR-0036 Non-Goal 3, `scripts/stop-archive.mjs`).
Note also that `/founder:start` marks terminal before the owner saves or commits,
so the HEAD-movement gate usually fails on the same turn and the archive lands
after that commit.

Consequences for a runbook author:

- **Decide before writing the marker.** If the workflow must stay open past this
  turn, do not set `--terminal-marker true` yet.
- **The unset window closes at that Stop, and it is a partial rollback.**
  `set-terminal --terminal-marker false` is accepted by both CLIs (covered by
  `tests/orchestrator/test-handoff-sidecar.mjs`), but it is not a bare flag —
  `--workflow-path`, `--host` and `--terminal-phase` are all still required, it
  rewrites `current_phase` to whatever phase you pass rather than restoring the
  previous one, it leaves `next_action` untouched unless you pass a new one, and
  it does not retract a handoff projection or footer the `true` write already
  emitted. Once the file has moved, recovery is a fresh workflow.
- **Codex defers rather than skips.** Its Stop hook is declared in
  `adapters/codex/hooks/hooks.json`, but it runs only once the operator has
  reviewed and trusted the plugin hooks (`/hooks`). Until then no evaluation
  happens at all, so the unset window stays open across turns and the archive
  lands on the first trusted Stop (or a manual run of the adapter hook).

## Fail-closed baseline (ADR-0043 §2)

The founder sidecar follows engineer's **path-targeted projection**
semantics plus orchestrator's **hardened delivery**:

- the projection is computed for the **exact workflow being terminated
  (by path)**, never a current-branch lookup — `set-terminal` can be
  invoked cross-branch;
- **stderr only, never stdout** (the completion scripts' stdout is a
  load-bearing machine channel: path-only / JSON);
- **fail-closed silent** — a missing/too-old runtime emits nothing and
  never throws; the completion proceeds and the SessionStart backstop
  still re-surfaces the pending handoff;
- **delivery failure returns not-rendered** — a footer that could not be
  written to stderr leaves the marker un-upgraded, so the SessionStart
  nudge still fires (a swallowed delivery failure never counts as a
  rendered footer);
- **a failed emit clears any stale projection** from a prior successful
  emit — the stable file always reflects *this* emit;
- **idempotent** — rendered at most once per terminal transition (the
  sibling marker below), and a rendered footer suppresses the false
  "missed-footer" SessionStart nudge;
- the projection slot is the single per-persona
  `.agentic-plugins/state/founder/last-session-handoff.json` (founder is
  canonical-home only, ADR-0036 SD5). Concurrent cross-branch terminals are
  **last-writer-wins** on the slot (accepted by ADR-0043 §2; the marker
  prevents double render, not cross-workflow overwrite).

**Scope honesty (inherited limitations):** the branch-agnostic Stop-hook
**orphan sweep** archives deleted-branch terminal workflows **without** a
final sidecar emit attempt — same as engineer/orchestrator. A workflow
that terminalizes and whose branch is deleted before any Stop fires gets
no footer and no pending handoff. Two further slot-model properties are
inherited and accepted (ADR-0043 §2 keeps the ADR-0031 single-slot design;
per-workflow projection files are explicitly out of scope): projection and
marker writes are plain truncating writes (a concurrent reader of a
half-written file fail-closes to "no handoff" rather than corrupting), and
SessionStart's consume runs after `stdout.write` returns without a
delivery acknowledgment — a truncated injection can lose the one pending
nudge. The render itself reads an immutable per-process snapshot, so a
concurrent cross-branch overwrite of the slot can no longer mix one emit's
completion flags with another emit's projection.

## Footer-rendered marker (documented cross-package contract)

ADR-0043 §2 fixes the marker as a contract (the attention follow-up
consumes this documentation, not the implementation):

- **filename**: `<projectionFile>.footer-rendered`, i.e. the canonical
  slot's sibling
  `.agentic-plugins/state/founder/last-session-handoff.json.footer-rendered`
  (the engineer slot shape — founder shares the single-projection-slot
  structure);
- **JSON shape**: `{"workflow_id": <id>, "status": "claimed"|"rendered",
  "at": <iso-utc>}`;
- a render **counts only** as `status === 'rendered'` for the matching
  `workflow_id`; a bare `claimed` marker is an in-flight/crashed render
  and never suppresses the backstop;
- **tombstone semantics** (founder divergence from the engineer copy): a
  `rendered` marker **survives** SessionStart consumption of the one-shot
  projection. founder's publish-needed workflow stays active-terminal until
  the owner publishes, so the surviving tombstone is what keeps every later
  Stop backstop from re-rendering the already-delivered transition
  (set-terminal → SessionStart consume → Stop would otherwise re-render).
  Only a **new primary transition** (the `setTerminal` emit, which may
  legitimately re-render a re-terminalized workflow) or a **different
  workflow's** claim replaces it; a `claimed` marker is still removed on
  consumption.

Pinned by `tests/founder/test-footer-activation.mjs` and
`tests/founder/test-handoff-backstop.mjs`.

## Completion-flag mapping (publish-needed; completion-output contract §2)

founder is a **manually-published lifecycle**: verbs terminalize without
auto-committing — the owner saves/commits the deliverable to their venture
repository (ADR-0036 SD5). The sidecar therefore maps `--completion-state`
from founder's **own** terminal semantics, not engineer's dichotomy:

- archive gate `blocked` with **only `head_moved` unmet** →
  **`publish-needed`** (the deliverable awaits the owner's save/commit;
  `head_moved` is a fail-closed collapse that also covers a failed git
  probe — the wording never overclaims a single cause);
- archive gate `blocked` with any **other** gate unmet (`terminal_phase`,
  `no_active_children`) → **`blocked`**, with gate-specific unblocking
  actions;
- otherwise → **`next-work-available`**.

The reason names the projection phase (+ the failed gate tokens when
blocked); the recommended next work carries the workflow's `next_action`
verbatim; `publish-needed` and `blocked` completions always pass an
explicit `--completion-next-action` (the contract's §3.2 marker-free
floor: a founder terminal footer never renders a `[generic fallback]`
marker).

## How to compute + pass the projection (pre-work / manual preflight)

The recipe below is the **contract reference** for a *pre-work* preflight
surface; at completion the same projection is computed and handed to
`footer.mjs` automatically by `emitTerminalHandoffSidecar` via the
`discover-runtime.mjs` resolver (copy-not-import, ADR-0010 §5).

```bash
# 1. Compute the bounded projection from founder's OWN state.
HANDOFF="$(node "$CLAUDE_PLUGIN_ROOT/scripts/session-handoff.mjs" project \
  --repo-root "$REPO_ROOT" --routing "/founder:resume")"
STATUS="$(echo "$HANDOFF" | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{try{process.stdout.write(JSON.parse(s).status||"")}catch{}})')"
# Routing is always present in the result (ADR-0031 input (c)) — pass it
# standalone when there is no projection so the seam never loses it.
ROUTING="$(echo "$HANDOFF" | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{try{process.stdout.write(JSON.parse(s).routing||"")}catch{}})')"

case "$STATUS" in
  ok)
    # 2. Materialize just the projection object to a temp file and pass it to
    #    the runtime seam. runtime composes context-risk × archive_gate into
    #    the continue-vs-fresh decision + next-session prompt/command.
    PROJ_FILE="$(mktemp -t founder-projection.XXXXXX).json"
    echo "$HANDOFF" | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{process.stdout.write(JSON.stringify(JSON.parse(s).projection))})' > "$PROJ_FILE"
    #   runtime:context check --risk <green|yellow|red> --workflow-projection-file "$PROJ_FILE"
    ;;
  no_active_branch_context)
    # Detached HEAD — report it, do NOT auto-recommend a fresh session
    # (ADR-0018 §sub-2). Surface: "no active branch context".
    ;;
  no_active_workflow|fail_closed)
    # No active founder workflow, or a corrupt state. Degrade: NO projection,
    # but routing is still available — pass it standalone so the seam keeps
    # the routing-shaped next command:
    #   runtime:context check --risk <green|yellow|red> --routing-recommendation "$ROUTING"
    ;;
esac
```

## Runtime discovery floors (dual-consumer, ADR-0043 §4)

`discover-runtime.mjs` carries **two independent floors**, each gating on
its own capability file:

- **footer floor** `MIN_RUNTIME_VERSION` (gates on `scripts/footer.mjs`) —
  the first released runtime containing the ADR-0043 S2 enum expansion; a
  runtime below it would reject `workflow_kind: founder` and render the
  unsupported-kind degradation text, so discovery fail-closes instead
  (silent, no stale-cache fallback);
- **notify floor** `NOTIFY_MIN_RUNTIME_VERSION` (gates on
  `scripts/notify.mjs`) — unchanged by the footer onboarding; the
  peer-runner self-sensor passes it explicitly.

## Codex hook parity (diagnose + operator attestation only)

The primary emission fires **synchronously at completion** and is fully
host-symmetric: a Codex `$founder:<verb>` completion runs the same
`set-terminal` CLI and renders the same footer. What is not
non-interactively provable on Codex is the *hook-borne* re-surfacing
(Stop backstop + SessionStart re-injection): those ride the packaged
hooks, which require the stage-appropriate hook gate plus a `/hooks`
review/trust — and every hook-bearing founder upgrade requires a fresh
`/hooks` re-attestation (`runtime:settings --attest-codex-hook-review`;
diagnose with `runtime:doctor`). This is the honest-scope boundary
(ADR-0001 §5): the durable state is host-shared; only the automatic
re-injection depends on the attested Codex hook state.

## Rollback note (ADR-0043 §5)

Rollback order is **personas first, runtime second**: the discovery floor
compares versions, not capabilities, so a runtime release that reverted
the four-persona seam would still satisfy `>= 0.79.0` and founder sidecars
would keep firing into honest-but-silent rejection. Rolling back the
founder package alone is safe; it leaves the durable one-shot artifacts
behind — remove
`.agentic-plugins/state/founder/last-session-handoff.json*` (projection +
rendered-marker tombstone) so a later re-enable cannot surface a
pre-rollback handoff as current.

## Boundaries

- **Workflow-state read-only.** `session-handoff.mjs` only reads founder
  workflow state and runs the pure evaluator; it never archives, marks
  terminal, or mutates the workflow. Its only writes are founder's own
  handoff artifacts — the projection slot, the render snapshot, and the
  footer-rendered marker. The runtime footer it feeds is advisory and
  pointer-only.
- **Fail-closed.** A corrupt founder state yields no projection; the seam
  degrades to context-risk + routing rather than trusting a partial
  projection.
- **No auto-fresh on detached HEAD.** The branch-based preflight reports
  "no active branch context" and never recommends a fresh session from a
  state with no branch to anchor to. The path-targeted terminal sidecar
  does not consult the branch at all — it renders normally for the exact
  workflow it was handed and stays advisory.
