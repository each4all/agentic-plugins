This is the {{persona}}-side wiring for the **session-level continue-vs-fresh
preflight** (ADR-0031) and the **code-emitted completion footer**
(ADR-0039, enabled for {{persona}} by ADR-0043). The **canonical contracts** —
the firing rules, the three inputs, the bounded projection schema, and the
continue-vs-fresh decision policy — live in {{persona}}'s own
`entry-routing-contract.md` § Session-Level Continue-vs-Fresh Preflight
(ADR-0031), beside this file (the single source; restating the schema
here would drift). The completion-flag minimum content is owned
by the runtime's `docs/completion-output-contract.md`. This file holds only
the {{persona}}-local wiring: how a {{persona}} surface computes its own bounded
projection, passes it **into** the runtime seam (L3 → L1; the runtime never
reads {{persona}} state), and what the code-emitted terminal path guarantees.

## When it fires

- at **standalone verb / lifecycle completion** — **code-emitted**
  (ADR-0039 via ADR-0043): the terminal mutation (`state.mjs
  set-terminal`, the production completion entry point for the six verb
  commands and the `/{{persona}}:start` terminal step) fires
  `emitTerminalHandoffSidecar`, which — after writing the projection —
  shells out to the runtime `footer.mjs` and prints the completion footer
  (context state, completion state + next action, workflow id/path,
  artifact pointers, recommended next work, and the continue-vs-fresh
  session-handoff) on the caller's **stderr**. The model does **not**
  hand-compose it at completion; it surfaces the emitted one.

  The sidecar supplies **no** `--context-state`: it owns no context-budget
  sensor, and footer.mjs reads a supplied value as a caller assertion.
  Against runtime **≥ 0.92.0**, where context provenance shipped, the footer
  reports `context state: unmeasured (no budget sensor)` and names the
  conservative yellow as runtime's own fallback in the continue-vs-fresh
  block. Older runtimes are still reachable — discovery floors at
  **{{footer_floor}}** here — and there the render is unchanged
  (`context state: yellow`): omitting the flag is byte-identical to passing
  it below 0.92.0, which is why no capability floor guards the omission. A
  measured risk is still honored when a caller that actually measures one
  passes it.
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
{{persona}} workflow is archived then; if any fails it stays marked and a later Stop
re-evaluates it. Same-turn *evaluation* is the guarantee; same-turn *archival* is
not, and the move itself is best-effort and non-fatal.

{{^capability dispatch_target}}
No parent writeback fires here at all: {{persona}} declares `dispatch_target` off,
so it carries no orchestrator parent and the step is removed outright
(`scripts/stop-archive.mjs`).
{{/capability}}
{{#capability dispatch_target}}
A workflow the orchestrator dispatched carries its parent, and the parent
writeback runs after the archive move (`scripts/stop-archive.mjs`).
{{/capability}}
{{^capability commit_surface}}
Note also that `/{{persona}}:start` does not auto-commit, so the HEAD-movement gate
usually fails on the same turn and the archive lands after the owner commits.
{{/capability}}

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

The {{persona}} sidecar follows engineer's **path-targeted projection**
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
  `.agentic-plugins/state/{{persona}}/last-session-handoff.json`
{{^capability legacy_homes}}
  ({{persona}} declares `legacy_homes` off: canonical home only).
{{/capability}}
  Concurrent cross-branch terminals are
  **last-writer-wins** on the slot (accepted by ADR-0043 §2; the marker
  prevents double render, not cross-workflow overwrite).

**Scope honesty (inherited limitations):** the branch-agnostic Stop-hook
**orphan sweep** archives terminal workflows whose branch is not checked
out — deleted, or kept and moved past its baseline — **without** a final
sidecar emit attempt, same as engineer's sweep (orchestrator's Stop runs
its handoff backstop before its archive scan). A workflow that
terminalizes and whose branch is deleted or switched away from before any
Stop fires on it gets no backstop emit, so a missed primary emit leaves it
with no footer and no pending handoff. Two further slot-model properties are
inherited and accepted (ADR-0043 §2 keeps the ADR-0031 single-slot design;
per-workflow projection files are explicitly out of scope): projection and
marker writes are plain truncating writes (a concurrent reader of a
half-written file fail-closes to "no handoff" rather than corrupting), and
SessionStart's consume runs after `stdout.write` returns without a
delivery acknowledgment — a truncated injection can lose the one pending
nudge. The render itself reads an immutable per-process snapshot, so a
concurrent cross-branch overwrite of the slot can no longer mix one emit's
completion flags with another emit's projection. The single-workflow marker
shares the same LWW family: a different workflow's later claim replaces the
tombstone, so under concurrent cross-branch terminals a still-active
publish-needed workflow's Stop backstop can re-render an already-delivered
transition — accepted with the slot model (a slot-transaction redesign is a
cross-persona follow-up, not this onboarding).

## Footer-rendered marker (documented cross-package contract)

ADR-0043 §2 fixes the marker as a contract (the attention follow-up
consumes this documentation, not the implementation):

- **filename**: `<projectionFile>.footer-rendered`, i.e. the canonical
  slot's sibling
  `.agentic-plugins/state/{{persona}}/last-session-handoff.json.footer-rendered`
  (the engineer slot shape — {{persona}} shares the single-projection-slot
  structure);
- **JSON shape**: `{"workflow_id": <id>, "status": "claimed"|"rendered",
  "at": <iso-utc>}`;
- a render **counts only** as `status === 'rendered'` for the matching
  `workflow_id`; a bare `claimed` marker is an in-flight/crashed render
  and never suppresses the backstop;
- **tombstone semantics** ({{persona}} divergence from the engineer copy): a
  `rendered` marker **survives** SessionStart consumption of the one-shot
  projection. {{persona}}'s publish-needed workflow stays active-terminal until
  the owner publishes, so the surviving tombstone is what keeps every later
  Stop backstop from re-rendering the already-delivered transition
  (set-terminal → SessionStart consume → Stop would otherwise re-render).
  Only a **new primary transition** (the `setTerminal` emit, which may
  legitimately re-render a re-terminalized workflow) or a **different
  workflow's** claim replaces it; a `claimed` marker is still removed on
  consumption.

Pinned by `tests/persona-pipeline/test-footer-activation.mjs` and
`tests/persona-pipeline/test-handoff-backstop.mjs`, which run for every
persona the session-handoff script is generated into (ADR-0066).
