### Decision policy (continue-vs-fresh)

The seam maps (context-risk × `archive_gate`) to `recommended_session`. The
policy is quality-first: it never fragments an in-progress unit while budget is
green, and it hands off once context is genuinely at risk.

| context-risk ↓ \ archive_gate → | `ready_to_archive` | `blocked` / `not_terminal` | absent (no projection) |
|---|---|---|---|
| **green** | `current_or_resumed` | `current_or_resumed` | `current_or_resumed` |
| **yellow** | `fresh_or_resumed` (clean seam) | `current_or_resumed` (+ risk caution) | `current_or_resumed` (+ risk caution) |
| **red** | `fresh_or_resumed` | `fresh_or_resumed` (+ resume command) | `fresh_or_resumed` |

The routing recommendation (c) does **not** flip the binary decision; it shapes
the **content** of the next-session prompt (what to start or resume). That is
how routing "breaks ties": the same `recommended_session`, a routing-specific
`next_command`.

### The output: continue-vs-fresh

The extended `buildHandoffGuidance` (`context.mjs`) emits:

- **`recommended_session`**: `current_or_resumed` (continue here) vs
  `fresh_or_resumed` (hand off), per the policy table above.
- **archive-gate report**: the projection's `archive_gate` surfaced verbatim —
  a **report** that the workflow is or is not ready to archive, never an
  archive action; omitted when (b) is absent.
- **next-session prompt / command**: when `fresh_or_resumed`, a concrete start
  prompt + command (the resume command for an active workflow, or the
  routing-table command for new work). The budget check
  (`runtime:context check`) and the completion footer are read-only and
  persist neither; the prompt reaches the **existing** `runtime:context`
  artifact's next-session field only when a surface runs `runtime:context
  capture` with `--next-session-prompt`.

The projection itself is not ephemeral here: at each terminal emit the
{{persona}} sidecar writes it to one per-persona slot,
`.agentic-plugins/state/{{persona}}/last-session-handoff.json`, the guaranteed
channel of the handoff. The footer renders from a per-emit
snapshot of it, never from the shared slot, which is last-writer-wins across
concurrent terminals. An emit that cannot project clears a stale projection
from a prior emit rather than let it be served (`session-handoff.md`
§ Fail-closed baseline (ADR-0043 §2)).
{{#capability legacy_homes}}
A workflow that still lives in the pre-migration home,
`.claude/agentic-{{persona}}/`, writes its projection to that home's
`last-session-handoff.json` instead, and SessionStart reads both slots,
canonical first.
{{/capability}}

### Boundaries (carried from ADR-0024 / ADR-0031)

- **The runtime is non-mutating.** The preflight emits a prompt, a command,
  and an archive-gate **report**. It never marks a workflow terminal, never
  archives, and never mutates / compacts / switches / starts host session
  context.
- **Archive readiness is gate-driven and side-effect-free.** `archive_gate`
  comes from the owning plugin's **pure** evaluator, not the Stop runner. The
  automatic archive happens in the persona's Stop hook, preserving the
  ADR-0017 auto-archive invariants: on the checked-out branch once every gate
  passes, HEAD movement past the baseline among them; and in the off-branch
  sweep, which judges a kept branch by its own tip and archives a terminal
  workflow whose branch was deleted with no HEAD-movement gate (a deleted
  branch has no tip to judge).
{{#capability commit_surface}}
  The commit command's no-changes close (`phase7-commit.mjs`) archives its
  workflow itself, right after its terminal write: with nothing committed,
  HEAD never moves past the baseline, so the Stop hook would never pass it.
{{/capability}}
  An owner archives a stale workflow on purpose with `/{{persona}}:resume
  archive`.
- **One projection per surface.** A completing surface projects **its own**
  workflow only; macro projection happens at the orchestrator surfaces. The
  two are never merged.
- **No new surface.** The runtime composition extends the existing
  `footer.mjs` / `context.mjs` caller-supplied-fields design: no new plugin,
  verb or skill category (ADR-0029).
