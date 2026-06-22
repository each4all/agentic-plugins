# ADR-0031: Session-level active handoff layer

## Status

Accepted (amended 2026-06-22 — *active firing via completion-script
sidecar*; see [Amendment](#amendment-2026-06-22-active-firing-via-completion-script-sidecar) below. The original projection-model decision stands unchanged; the amendment adds how it **actively fires**.)

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

---

## Amendment (2026-06-22): Active firing via completion-script sidecar

### Context

The original decision shipped the projection **model** (PRs #376–#386):
each owning layer computes a bounded projection and passes it into the
runtime seam, which composes the continue-vs-fresh decision. That model
is sound and remains unchanged.

But it is **passive**. The firing rules (item 5 above) are realized only
as **prose** in command runbooks and `SKILL.md` files ("render the
runtime completion footer", "surface the ADR-0031 preflight"). Nothing
runs the seam unless the agent follows that prose. In practice the
session-level continue-vs-fresh handoff has **zero active triggers** —
it depends entirely on the LLM choosing to honor a markdown instruction
at the end of a verb. This amendment closes that gap: it makes the
handoff fire from code that runs on the completion path itself.

The firing surfaces and their binding constraints were mapped by the
activation macro's first subtask (`handoff-surface-map`,
`investigate-20260622T042540Z-7cf0ae`; local 3-agent scan + Codex peer
`investigate-20260622T043327Z-1c378c79`). The durable map is
[`0031-activation-firing-surface-map.md`](0031-activation-firing-surface-map.md).

### Decision

**Fire the session-handoff projection from within the must-run
completion *scripts*, not from runbook prose.** Concretely:

1. **Firing locus = the exported mutation helper, fired once on success.**
   The sidecar attaches to the *exported helper* that performs the
   terminal mutation — engineer `setTerminal()` and orchestrator
   `setMacroTerminal()` — **not** the `set-terminal` CLI `case`. This is
   load-bearing: `phase7-commit.mjs` imports and calls `setTerminal()`
   **directly** (`plugins/engineer/scripts/phase7-commit.mjs:46`,
   `:1006`), so wiring only the CLI case would miss the entire
   `/engineer:start` Phase 7 path, while wiring **both** the helper and
   `phase7-commit` would double-fire. Wiring the single helper covers the
   standalone-verb CLI path *and* the Phase 7 path with exactly one
   emission. The sidecar runs **after the mutation succeeds and after the
   per-file lock is released** (never against pre-terminal state, never
   under the lock). It keys on the mutation succeeding, never on parsing
   or appending to stdout.

   For the orchestrator `updateSubtask` auto-terminal pass, the sidecar
   fires **only when `autoTerminal === true`** (the macro actually became
   terminal this call;
   `plugins/orchestrator/scripts/state.mjs:2814`) — never on the
   non-terminal `status=in_progress` dispatch path that `/orchestrator:next`
   uses (`plugins/orchestrator/commands/next.md:354`).

2. **Output channel = a projection file (guaranteed) + a best-effort
   stderr advisory — never stdout.** The completion scripts have
   load-bearing stdout contracts callers already parse:
   `set-terminal`/`setMacroTerminal` emit the workflow **path only**
   (`state.mjs:3544` / `:3793`); `phase7-commit` emits **JSON**
   `{ok, landed}` (`phase7-commit.mjs:1420`); `updateSubtask` emits a
   **JSON envelope** (`state.mjs:3848`). The sidecar MUST NOT add prose
   to stdout. The **guaranteed** channel is a materialized projection
   **file/pointer** the footer step reads — because successful **stderr
   can be captured or discarded by programmatic callers** (e.g. the
   phase7 test wrapper returns `stderr: ''` on success,
   `tests/engineer/test-phase7-commit.mjs:581`), so a stderr advisory is
   a **best-effort nudge for visible shell/tool invocations only**, not a
   guaranteed surface. Both are emitted; neither touches stdout.

3. **Wiring respects the import graph — lazy, inside an async function,
   never top-level.** A static `state.mjs → session-handoff.mjs` import
   creates a module cycle: `session-handoff.mjs` statically imports
   `state.mjs` **and** `stop-archive.mjs` (`session-handoff.mjs:21`), and
   `stop-archive.mjs` imports `state.mjs` (`stop-archive.mjs:22`). The
   helper therefore invokes the projection via the **lazy `await
   import()`** pattern already used for `state.mjs`'s stop-archive call
   (`plugins/engineer/scripts/state.mjs:3610`). The safety condition is
   strict: the dynamic import must sit **inside an async function**, never
   at top level — `state.mjs:3640` warns that a top-level `await import`
   of a module that imports back into `state.mjs` can deadlock module
   settlement. A subprocess is the alternative if a synchronous mutation
   path cannot host an `await`.

4. **Risk defaults to `yellow` when fired from a script.** Context-budget
   risk is caller-supplied and not host-measurable (item 7). When the
   sidecar fires from a completion script there is no caller risk to
   read, so it defaults to **`yellow`** — matching runtime's existing
   treatment of absent/unrecognized risk as yellow
   (`plugins/runtime/scripts/context.mjs:789`; asserted by
   `tests/runtime/test-context.mjs:436`). Yellow is the *conservative
   composer input*, not a verdict: yellow + a `blocked`/`not_terminal`
   archive gate still composes to **continue** (`context.mjs:807`), while
   yellow + `ready_to_archive` leans fresh. The agent may refine the risk
   when it renders the footer with better context.

5. **Reuse projection compute only; do not import runtime; resolve
   repo-root.** The sidecar calls the existing per-plugin
   `computeEngineerProjection` / `computeOrchestratorProjection`
   (`session-handoff.mjs:77` / `:87`) and **emits the bounded projection
   to the file/pointer** (decision 2) plus a one-line advisory. It does
   **not** import or call the runtime seam: the continue-vs-fresh
   composition (`evaluateSessionHandoff`, `context.mjs:789`) stays in the
   footer/`runtime:context` path exactly as today — keeping the hot
   completion path free of an L3/L2 → L1 runtime dependency and leaving
   composition single-sourced. Because `state.mjs set-terminal` takes no
   `--repo-root` (`state.mjs:3518`) but the compute functions are
   repo-root based, the helper resolves repo-root via the existing private
   path inference (`state.mjs:242`, orchestrator `state.mjs:355`).

6. **Fail-closed and non-fatal.** A projection error must never fail the
   completion or the commit. On any error the sidecar writes a one-line
   diagnostic to stderr, emits no projection file, and the completion
   script proceeds and exits normally. This reuses the existing
   fail-closed precedents (`context.mjs`
   `loadWorkflowProjection`/`normalizeProjection` degrade to no
   projection; `stop-archive` returns non-throwing failure envelopes; the
   orchestrator A4 scan sets a fail-closed sentinel).

7. **Honest limit (markdown-command boundary).** This makes firing
   *script-enforced* but not *host-enforced*. The completion script still
   only runs because the completion runbook invokes it — and a markdown
   command/skill cannot be *forced* to run by either host. So the sidecar
   guarantees: *if a workflow actually reaches its terminal mutation, the
   handoff fires.* It cannot guarantee a workflow is driven to completion
   at all. That residual limit is the same markdown-honesty boundary
   ADR-0031 already acknowledged for risk measurement (item 7) and is
   documented, not hidden. The optional `engineer-hook-backstop` /
   `orchestrator-hook-backstop` subtasks narrow it further: the repo
   already ships SessionStart/PreCompact/Stop hook bindings
   (`plugins/engineer/hooks/hooks.json`,
   `plugins/engineer/adapters/codex/hooks/hooks.json`) on which a
   late-reinjection backstop can ride — subject to the documented Codex
   `/hooks` trust boundary (`plugins/orchestrator/skills/finalize/SKILL.md`).

8. **A mandated regression test guards the wiring.** Because the failure
   mode is silent (a refactor that drops the sidecar call reverts to the
   passive gap with no error), each wired completion script gains a test.
   The test is host-free and deterministic: spawn the CLI on a temp
   workflow, assert (a) exit 0, (b) **stdout byte-for-byte unchanged**
   (path-only / JSON contract intact), (c) the projection **file** was
   written and (d) a bounded advisory reached stderr, and (e) the
   terminal state mutation actually landed. It must **not** assert on the
   current checkout branch — `currentGitBranch` shells out under
   `repoRoot` and returns empty on detached/non-git
   (`plugins/engineer/scripts/state.mjs:655`), which would make the test
   environment-dependent. Existing host-free projection/risk tests are the
   precedent (`tests/runtime/test-footer.mjs`, `test-context.mjs`).

### Why script-level (B), not runbook-level (A)

The `handoff-surface-map` compact lens leaned toward **(A) wiring at the
command-runbook level** (call session-handoff as a separate runbook step
after the mutation) on the Foundation axis — it keeps the scripts
untouched, so there is trivially no cycle and no stdout risk. That lens
**under-weighted the Essence axis for the activation goal**: a runbook
step is *also* markdown prose, so (A) does not escape the very
prose-dependence this amendment exists to remove — it would re-state the
passive gap in a different file. **(B) script-level firing** fires from
code on the completion path without depending on the agent reading prose,
and the constraints that disfavored it (cycle, stdout) are fully solvable
with the lazy-import precedent (decision 3) and the file/stderr channel
(decision 2). On the decisive Essence + Foundation axes, B wins once
Essence is scored correctly; A survives only as the trivial-speed option
that does not actually activate.

B is **not** the only code-level trigger — the repo also ships host hook
bindings (SessionStart/PreCompact/Stop), so a **hook-backed variant**
("C", fire from a host hook) also escapes prose. C is deferred to the
optional `*-hook-backstop` subtasks rather than chosen as the primary,
because hooks are host-conditional (Codex requires `/hooks` trust, not
non-interactively provable) whereas the completion scripts run on every
host. B is the host-independent primary; C is the complementary backstop.
This ordering is consistent with the macro plan's pre-committed direction
("sidecar firing at must-run completion scripts").

### Scope — founder deferred

`founder` is a shipped L3 persona that copied the workflow machinery
including `session-handoff.mjs` (ADR-0036), and therefore has the same
firing surfaces: `setTerminal()` (`plugins/founder/scripts/state.mjs:2274`),
a path-only `set-terminal` CLI (`:3284`), and
`computeFounderProjection` (`plugins/founder/scripts/session-handoff.mjs`).
This activation macro **explicitly excludes** founder-side wiring — its
subtasks cover engineer and orchestrator only. Founder-side activation is
**deferred** (consistent with founder skills already marking deeper
ADR-0031 integration "future work"); when taken up it follows this
amendment's same eight decisions verbatim, since founder's surfaces are
structurally identical to engineer's.

### Implementation ordering (for the sidecar subtasks)

Per the Plan-verify peer: implement a **shared per-plugin sidecar helper
first** (compute projection → write file → best-effort stderr advisory →
catch-all → no stdout), then wire it into the mutation helper call sites.
The helper runs **after the mutation succeeds and after lock release**, so
it computes against terminal (not pre-terminal) state and never holds the
lock during projection I/O.

### Consequences

**Positive**: the continue-vs-fresh handoff fires from the completion
path instead of from hope-the-agent-reads-the-footer prose; the projection
model is unchanged (pure extension); stdout contracts and the L2/L3 → L1
dependency direction are preserved; the failure mode is guarded by a
regression test.

**Negative**: each completion script gains a lazy-import + emit step and a
test; the wiring is spread across engineer + orchestrator scripts (the
later sidecar subtasks); the honest limit (decision 7) means firing is
script-enforced, not host-enforced.

**Neutral**: surfacing shifts from a footer-prose step to a script-emitted
stderr advisory plus the (still prose-rendered) footer — the footer
remains, but no longer the *only* trigger.

This amendment governs the remaining activation subtasks: `engineer-sidecar`
and `orchestrator-sidecar` (wire the emit into each plugin's completion
scripts), `runtime-unsupported-kind` (honest unsupported-kind reporting),
and the optional `engineer-hook-backstop` / `orchestrator-hook-backstop`
(host-hook backstops that narrow the decision-6 limit).
