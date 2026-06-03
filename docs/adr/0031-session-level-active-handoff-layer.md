# ADR-0031: Session-level active handoff layer

## Status

Proposed

## Context

The active-guidance work to date (ADR-0029) operates at **verb
completion** granularity: a standalone `/engineer:<verb>` emits an
Active Next-Action Proposal, and a non-decide verb may surface a
cross-verb multi-axis lens at a 2+-branch point. There is no equivalent
at the **session** level. Nothing proactively answers, before guiding
the user toward the next piece of work, the question *"should this work
continue in the current session, or should it hand off to a fresh
session?"* — and if a fresh session is warranted, nothing prepares the
handoff (reports archive readiness, captures artifacts, emits a concrete
next-session start prompt).

An investigation (engineer workflow `investigate-20260603T112305Z-b2d268`,
peer envelope `investigate-20260603T112520Z-cd7742`) mapped the existing
parts and confirmed the gap precisely:

- A session-level continue-vs-fresh **primitive already exists** —
  `buildHandoffGuidance()` in `plugins/runtime/scripts/context.mjs:650`
  returns a `recommended_session` of `current_or_resumed` vs
  `fresh_or_resumed`, and the green/yellow/red `defaultNextAction`
  strings in `context.mjs` / `footer.mjs:965` already speak
  continue-vs-fresh.
- But **nothing composes the three inputs** a real session decision
  needs: (a) context budget risk, (b) the active engineer/orchestrator
  workflow state (phase, next_action, checkpoint, archive-gate
  readiness), and (c) the entry-routing-contract routing perspective.
  `context.mjs` reads neither workflow state nor the contract; every
  reference to the footer/context from the engineer and orchestrator
  runbooks is prose-only ("render the same fields manually").
- The runtime layer is bound by hard constraints: it must not mutate,
  compact, switch, or start host session context (ADR-0024; runtime
  `README.md:27` — runtime does not own persona or macro work); no new
  plugin / verb / skill category (ADR-0029); no cross-plugin imports,
  and lower layers must not depend on higher layers (ADR-0010 §dependency
  direction). runtime is L1; orchestrator is L2; engineer is L3.

A macro plan (`macro-plan-20260603T114201Z-d5b1c9`) decomposed the
feature into five subtasks. This ADR records the **architectural
decision** that subtask `handoff-adr` is responsible for: how the
runtime layer obtains input (b) and where the continue-vs-fresh
composition lives.

The decision was reached through two independent dual-host ensembles
that converged: a Plan-verify peer
(`macro-plan-20260603T114333Z-47900a4`) and a Brainstorm peer
(engineer decide workflow `decide-20260603T120419Z-e752e6`,
verdict `agreed`). Both, independently, recommended the projection
model over the shell-read draft.

## Decision

Adopt the **projection (inversion-of-control) model**. The owning
layers compute their own state; the runtime layer composes a generic
decision from bounded inputs and never reads higher-layer state.

1. **Direction of data flow.** engineer (L3) and orchestrator (L2)
   completion surfaces read their **own** workflow state (via their own
   `state.mjs read` / `find-active`) and compute a **bounded workflow
   projection**. They pass that projection **into** the runtime seam.
   The runtime layer (L1) does **not** shell out to, import, or
   otherwise discover engineer/orchestrator state. Dependency direction
   stays L2/L3 → L1, matching ADR-0010.

2. **Projection schema (bounded, generic).** The projection carries
   only these fields, and only **generic semantic** values — never raw
   higher-layer internals the runtime would have to reinterpret:

   - `workflow_kind` (`engineer` | `orchestrator`)
   - `workflow_id`, `workflow_path`
   - `phase`, `next_action`
   - `checkpoint` (latest checkpoint summary, optional)
   - `archive_gate` — a generic readiness state
     (`ready_to_archive` | `blocked` | `not_terminal`), computed by the
     owning plugin's **pure** evaluator (`evaluateStopArchive` /
     `evaluateMacroStopArchive`), never by running the side-effecting
     Stop runner
   - `routing_recommendation` — the entry-routing-contract perspective,
     resolved by the owning surface

   It is passed as a single bounded `--workflow-projection-file`
   (mirroring the existing `--subtasks-json-file` /
   `$AGENTIC_DECIDE_CONTEXT_FILE` patterns), not as an explosion of
   per-field flags.

3. **Composition locus.** The runtime seam owns **only** the generic
   continue-vs-fresh composition (combining context budget risk +
   the bounded projection + routing recommendation via the existing
   `buildHandoffGuidance` primitive) and the next-session prompt
   rendering. Each owning plugin owns its own state interpretation and
   projection computation.

4. **Surface extension, not new surface.** The projection contract and
   firing rules are documented by **extending** the existing
   `plugins/runtime/docs/footer-contract.md` and
   `plugins/engineer/skills/_shared/references/entry-routing-contract.md`
   (a new session-level section). No new plugin, verb, skill category,
   or reference file is introduced (ADR-0029).

5. **Firing rules.** The session-level preflight is surfaced before the
   layer guides the user toward substantial next work — at engineer
   `start` Phase 0, at verb completion, and when context risk is
   yellow/red. On detached HEAD it reports *"no active branch context"*
   rather than auto-recommending a fresh session.

6. **Boundaries (unchanged).** runtime remains non-mutating: it emits a
   prompt and command and reports archive-gate readiness; it never marks
   a workflow terminal, never archives, and never mutates/compacts/
   switches/starts host session context. Cross-session persistence of
   the next-session prompt reuses the **existing** `runtime:context`
   artifact rather than introducing a second state-like artifact.

7. **Honest limit.** Context budget risk is **caller-supplied**, not
   host-measured (`context.mjs:344`). The session preflight cannot read
   true token usage on its own; it composes whatever risk the caller
   supplies (or defaults), and this limitation is surfaced, not hidden.

This decision governs the remaining macro subtasks: `contract` (the
contract-section compose), `runtime-seam` (the generic composer),
`engineer-wiring` and `orchestrator-wiring` (each computes its own
projection and calls the seam).

## Consequences

**Positive**:

- Correct layer direction: runtime stays generic and depends on nothing
  higher; future plugins (e.g., a `designer` persona) pass the same
  projection shape without runtime learning their schemas.
- Matches the existing runtime design exactly — `footer.mjs` /
  `context.mjs` already take caller-supplied bounded fields, so the seam
  is an extension of a proven pattern, not a new coupling.
- Archive readiness stays gate-driven and side-effect-free (pure
  evaluators), preserving the ADR-0017 Stop-hook auto-archive
  invariants.
- No new plugin/category; the smallest accurate structural footprint
  (ADR-0029 alignment).

**Negative**:

- More wiring than the shell-read draft: engineer and orchestrator each
  gain projection-computation code at their completion surfaces, rather
  than the logic living centrally in runtime.
- Two completion surfaces (engineer + orchestrator) must each be wired,
  and Codex parity (plugin_hooks + `/hooks` trust) applies to the
  orchestrator macro hooks — diagnosable but not non-interactively
  provable.

**Neutral**:

- The continue-vs-fresh decision shifts from an implicit, manual footer
  rendering to an explicit composed preflight — a change in shape that
  makes the existing primitive observable, without changing what runtime
  is allowed to do.

## Alternatives Considered

**Approach A — runtime shell-read / active resolver.** Runtime extends
`context.mjs` / `footer.mjs` to shell out to engineer/orchestrator
`state.mjs read` and compose the handoff centrally. *Rejected on the
decisive Foundation axis*: even though shelling avoids imports (and
ADR-0019 has command-surface precedent for orchestrator querying
engineer state), it makes L1 runtime know L2/L3 script paths and
frontmatter schemas, inverting the ADR-0010 dependency direction and
making runtime brittle to higher-layer schema drift. It also pulls
runtime toward owning persona/macro semantics (archive-gate
interpretation) it explicitly does not own (ADR-0024). Tempting only for
implementation speed (smallest change to completion surfaces).

**Approach C — neutral session-handoff projection artifact.** Define a
versioned neutral projection artifact written by engineer/orchestrator
and read by runtime by explicit pointer / latest lookup. *Rejected as
over-machinery for the first slice*: architecturally clean on layer
direction (runtime reads only an explicit neutral artifact), and the
best long-term shape if the projection ever needs durable cross-session
reuse, but it introduces a second state-like artifact with its own
freshness, retention, latest-selection, and conflict-handling lifecycle
— unnecessary when the continue-vs-fresh decision is computed and
consumed in the **same** completion flow. The durable cross-session need
is already met by the existing `runtime:context` artifact, so the chosen
Approach B borrows exactly that one element from C and no more.

Both A and C were evaluated against the nine-axis preset; A lost on the
two decisive axes (Essence, Foundation), C lost on Practical Fit /
Maintainability for the first slice. The full comparison is recorded in
the decide workflow `decide-20260603T120419Z-e752e6` and the macro plan
`macro-plan-20260603T114201Z-d5b1c9`.
