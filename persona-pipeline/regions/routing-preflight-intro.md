## Session-Level Continue-vs-Fresh Preflight (ADR-0031)

The Active Next-Action Proposal above answers *"what is the next step?"* at
**verb-completion** granularity. This section adds its **session-level**
counterpart: before a layer pulls the user toward substantial next work, it
answers *"should that work continue in the current session, or hand off to a
fresh one?"* — and, when a fresh session is warranted, prepares the handoff
(reports archive-gate readiness and emits a concrete next-session start
prompt). It does not replace the verb-level proposal; it sizes the session
around it.

Composition follows the **projection (inversion-of-control) model** of
ADR-0031 §Decision: the owning plugin computes its own workflow state and
passes a bounded projection *into* the runtime seam; the runtime layer (L1)
**extends** its existing `buildHandoffGuidance` composition (`context.mjs`) to
fold the projection in, and never shell-reads, imports, or discovers a
persona's (L3) or the orchestrator's (L2) state. Dependency direction stays
L2/L3 → L1 (ADR-0010); the rejected shell-read alternative is ADR-0031
Approach A.

> **Single source.** This section is the {{persona}} plugin's contract for the
> **firing rules, the three inputs, the projection schema, and the decision
> policy**; `session-handoff.md` (beside this file) holds only the
> {{persona}}-local wiring and cites this section rather than restating it.
> `plugins/runtime/docs/footer-contract.md` owns only the **footer rendering**
> of the result and references the canonical section for the schema and
> policy — a second definition would drift.
