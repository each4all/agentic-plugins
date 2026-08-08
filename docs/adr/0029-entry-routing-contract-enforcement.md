# ADR-0029: Extend entry-routing contract enforcement to standalone verbs — active, evidence-based next-action guidance

## Status

Accepted

> Amended 2026-08-08 — see [Amendment 2026-08-08](#amendment-2026-08-08).
> The registry-resolution host asymmetry this ADR scopes out is real, but
> the reason recorded for it in three places below is not: it names a Codex
> auto-activated skill mode that does not exist for these skills. The
> measured cause is that a Codex skill mention has no plugin-root variable
> in its environment. The scope-out itself stands.

## Context

The engineer plugin's six-verb decomposition (ADR-0010 §2) gave each
verb deep, rigorous behavior but left the **connective tissue between
verbs** — "what to do next, and why" — weak for *standalone* verb
invocations. A 2026-05-29 dogfood-driven review surfaced this as a felt
weakness in the *working experience* (the *artifact* quality is sound):
when a verb runs on its own, it ends by pointing at a fixed next verb
rather than actively reasoning about the best next action with
rationale, and the multi-axis quality lens
(표준 / 권장 / 정석 / 본질 / 근본 / 확장 / 유지보수 / 고도화 / 실용성,
per [ADR-0027](0027-decide-skill-multi-axis-evolution.md)) is only ever
reachable inside the `decide` verb.

### The accurate diagnosis: the contract exists and is enforced — but only at the lifecycle entry

`plugins/engineer/skills/_shared/references/entry-routing-contract.md`
already exists and already specifies the desired behavior:

- Its **Routing Recommendation** section requires "the selected route,
  the rejected alternatives that were plausible, and the next command
  to run" — and states "The default verb sequence is a fallback, not a
  mandate."
- Its **Decision Prompt Shape** requires options, tradeoffs, risks, a
  recommendation, confidence, evidence pointers, and a default next
  command — "Do not ask the user to choose from raw implementation
  details without this comparison."
- Its **Standards and Root-Cause Gate** (4 guarantees: source-of-truth,
  root-cause/invariant, verification evidence, rollback path) "is not
  optional."
- Its **decision-sizing** subsection maps decision weight →
  `engineer:decide` preset (minor→compact / standard→default /
  major→nine-axis), per ADR-0027 §1.5.

A repository scan establishes precisely where this contract is and is
**not** wired (file:line verified 2026-05-29):

- **Consulted** by the lifecycle entry and the decision verb:
  `plugins/engineer/commands/start.md:282` (Phase 0d), 
  `plugins/engineer/skills/start/SKILL.md:31`,
  `plugins/engineer/skills/decide/SKILL.md` (3 references, for the
  `entry-routing-guarantee` axis), and
  `plugins/engineer/skills/decide/references/decision-axes.yml`.
- **Not consulted** by any standalone verb command or its skill:
  `commands/{investigate,frame,decide,compose,critique,refine}.md` —
  **0 references each**; `skills/{investigate,frame,compose,critique,refine}/SKILL.md`
  — **0 references each**.

So the contract is **not orphaned** — `/engineer:start` honors it at
Phase 0d, and `decide` honors its gate. The gap is that the contract's
reach **stops at the lifecycle-macro boundary**. A user who runs a
single verb (e.g. `/engineer:investigate` without `/engineer:start`) —
which ADR-0012 condition 3 and the engineer charter explicitly support
— gets none of the contract's active-routing behavior.

### The two concrete weaknesses

- **W1 — Fixed "Recommended next verb" at standalone verb completion.**
  Each verb command's completion section prints a `### Recommended next
  verb` literal: `frame → /engineer:decide`
  (`commands/frame.md:158`), `decide → /engineer:compose`
  (`commands/decide.md:275`), `compose → /engineer:critique`
  (`commands/compose.md:176`) are single fixed literals;
  `investigate`/`critique` print a fixed header literal but add
  conditional prose nearby; `refine` is conditional. This fixed
  completion literal is exactly the "**Static lifecycle table: ending a
  verb with a hardcoded 'next: X'**" anti-pattern the contract names —
  but the contract is never consulted here to prevent it.

  Note the durable workflow state is *already* better than the display:
  the `state.mjs append --next-action` writes are descriptive prose
  (e.g. `frame.md:166` writes "Decide on a direction given this
  frame", not a bare verb literal). The weakness is the **completion
  display** the user reads, and the absence of the contract's
  evidence-based proposal shape (recommended + alternatives + rationale
  + evidence + confidence) at standalone verb boundaries.

- **W2 — Multi-axis lens is decide-only.** The 9-axis registry
  (`scripts/decide-registry.mjs` + `skills/decide/references/decision-axes.yml`)
  is reachable only from `commands/decide.md` Phase 0.5 (verified: zero
  `decide-registry` / `decision-axes` / `AGENTIC_DECIDE_CONTEXT`
  references outside `skills/decide` / `commands/decide`). The
  contract's own size→preset mapping is wired only into `decide`;
  `investigate` / `frame` / `compose` / `critique` / `refine` never
  surface a multi-axis lens even at a genuine 2+-branch decision point.

(A host-asymmetry concern was considered and **dropped** as a driver
for this ADR: the contract is consulted identically on both hosts via
the shared SKILL.md runbooks. The only host difference is that
command-mode `decide` reaches `decide-registry.mjs` while Codex's
auto-activated `decide` falls back to the in-code default — that is the
registry-resolution asymmetry already deferred under
[ADR-0013](README.md#status), not a contract-enforcement gap this ADR
owns.)

### Decision forces (constraints)

- **[ADR-0010](0010-plugin-boundary-policy.md) §6 separation
  triggers** — a new plugin requires one of {infra used by 2+ plugins /
  distinct cost-quota-auth / install-time mental-model discontinuity}.
  A cross-verb guidance mechanism fails all three today (the second L3
  persona, `designer`, does not yet exist) → no new plugin.
- **ADR-0010 §5** — cross-plugin imports forbidden; engineer-internal
  logic lives in `plugins/engineer/skills/_shared/references/`. A
  future `designer` L3 must **copy**, not import.
- **[ADR-0021](0021-codex-command-surface-parity-via-skill-wrappers.md)
  / [ADR-0022](0022-engineer-meta-skill-category.md)** — the
  `skills/<plugin>/` folder has exactly three categories
  (verb / macro / meta). Active guidance is none of these; a fourth
  category would erode the taxonomy.
- **[ADR-0020](0020-engineer-integrated-workflow-umbrella.md)** —
  rejected a new `plugins/workflow` L2 and kept cross-verb sequencing
  as command-internal choreography; `VALID_VERBS` stays six.
- The no-raw-output / pointer-only boundary
  ([ADR-0024](0024-runtime-operator-control-plane.md)) must hold:
  workflow state stores compact rationale + artifact pointers, never
  peer transcripts or full comparison dumps.

A Codex peer ensemble (independent 9-axis evaluation, run
`brainstorm-adr29-20260529T155702Z-868d200`) converged with the
orchestrator on the decisive axes (본질 / 근본): no new plugin, no new
skill category, the home is the existing engineer-internal contract.
First-principles file reading then corrected two specific claims that
both the orchestrator's and the peer's first pass had asserted without
verification — the contract is **not** orphaned (it has consumers at
`start` + `decide`), and there is **no** line-ending defect (the file
is already LF). This ADR encodes the verified diagnosis, not the first
pass.

## Decision

**Extend the existing entry-routing contract's enforcement from the
`/engineer:start` lifecycle entry to each standalone verb's completion,
and make the contract's size→preset axis lens reachable beyond
`decide`.** No new plugin, no new skill category, no new verb, no new
reference file.

### §1 — Active next-action proposal at standalone verb completion (addresses W1)

Each verb command's completion (and the mirrored SKILL.md completion)
consults `entry-routing-contract.md` and replaces the fixed
`### Recommended next verb` literal with the contract's existing
**Decision Prompt Shape** / **Routing Recommendation** output:

```
- selected_next:         <verb | "commit" | "owner decision">
- rejected_alternatives: [<verb> — <one-line why-not>, ...]   (1-2)
- rationale:             <grounded in the decisive axes 본질/근본 and
                          the Standards/Root-Cause gate result>
- evidence_pointers:     [<workflow phase / artifact pointer>, ...]
- confidence:            HIGH | MEDIUM | LOW
- next_command:          <exact next step: /engineer:<verb> ... / $engineer:<verb> for a verb; the commit / owner-decision action otherwise>
```

The routing table remains the **fallback** when evidence is genuinely
neutral (the contract already frames it this way); the change is that a
fixed literal is no longer the default completion output. The durable
`state.mjs --next-action` already carries descriptive prose; §1 brings
the **user-facing completion** up to the same contract standard, with
the added rationale/alternatives/evidence the contract requires.

This is the same behavior `/engineer:start` Phase 0d already performs —
§1 simply stops that behavior from being lifecycle-macro-exclusive.

### §2 — Cross-verb multi-axis surfacing (addresses W2)

The contract's existing size→preset mapping becomes consultable by
**any** verb that surfaces 2+ viable branches, not only `decide`.
Mechanically, `decide-registry.mjs` is the shared resolver (it already
reads `decision-axes.yml` and resolves a preset); the wiring lets a
non-`decide` verb that hits a genuine branch surface a **compact** axis
lens (the resolved preset's decisive axes 본질/근본 plus the
size-appropriate supporting axes) inline, sized per the mapping
(minor→compact / standard→default / major→nine-axis).

This is deliberately **bounded**: the axis lens appears only at a
genuine 2+-branch decision point, never on every verb invocation, and
honors decision size (the contract already forbids "applying the full
9-axis matrix to a trivial reversible change"). The registry stays the
single source of axis truth; no second axis list is created.

### §3 — Boundaries (what this ADR does NOT do)

- **No new plugin** (ADR-0010 §6 triggers all fail today).
- **No new skill category** (ADR-0021/0022 verb/macro/meta preserved).
- **No new verb** (`VALID_VERBS` stays six, ADR-0020 §Sub-decision 5).
- **No new reference file** — the existing contract is the home;
  a parallel `active-guidance-contract.md` would split the source of
  truth.
- **No raw output in state** — the proposal stores compact rationale +
  pointers (ADR-0024 boundary).
- **No change to the durable `next_action` schema** — §1 enriches the
  completion *display* and the proposal it records; it does not alter
  `state.mjs` frontmatter shape.
- **Auto-activation may stay lightweight** — §1 enforces the proposal
  *shape* and routing reasoning; it does not mandate peer dispatch on
  the shallow path.
- **No line-ending change** — the contract file is already LF; there is
  no hygiene defect to fix (an earlier unverified claim of a CR-only
  file was disproven before this ADR was finalized).
- **Registry host-asymmetry stays out of scope** — the command-mode
  vs auto-activated `decide-registry` reach difference is ADR-0013
  territory.

### §4 — Implementation roadmap (trigger-driven, not a committed timeline)

| PR | Scope | Trigger |
|---|---|---|
| **PR-A** | This ADR (Proposed) + `entry-routing-contract.md` gains an explicit "Active next-action proposal" output shape section (contract text only) | ADR-0029 approval |
| **PR-B** | Wire the consult + proposal into the standalone verb command completions, starting with the fixed-literal offenders (`frame`, `decide`, `compose`), then `investigate` / `critique` / `refine` | PR-A merged |
| **PR-C** | §2 cross-verb multi-axis surfacing via the shared `decide-registry.mjs` resolver at 2+-branch points | PR-B merged |
| **PR-D** | Mirror the §1 completion shape into each `skills/<verb>/SKILL.md` so the Codex skill-mention path matches (host parity for the contract surface) | PR-B merged (parallel with PR-C) |

PR-B is the first PR developable engineer-only against this ADR and is
a natural [ADR-0012](0012-omcc-removal-preconditions.md) condition-3
evidence-accumulation datapoint candidate.

## Consequences

**Positive**:

- Closes the felt working-experience weakness at its root: the
  contract's active-routing behavior, today exclusive to
  `/engineer:start`, reaches standalone verb usage too. The "active
  forward pull" omcc's monolithic `/start` had is restored for
  single-verb work without re-monolithizing.
- Single source of truth preserved and strengthened: the existing
  contract gains broader reach instead of a rival file diluting it.
- The 9-axis quality lens (본질/근본 decisive) becomes available wherever
  a real decision branch appears, directly serving the user-value
  definition (quality of decision support).
- Smallest accurate structural footprint: no new plugin / category /
  verb / file; the change is wiring + one tight contract-section
  addition.

**Negative**:

- Per-command integration touches every verb command (and SKILL.md
  mirror) — a broad, if mechanical, edit surface. The same drift risk
  that left the contract wired only at `/engineer:start` could recur;
  mitigated by making the per-completion consult the enforcement point.
- A verb producing a proposal does marginally more reasoning per
  completion than emitting a literal. This is the intended cost —
  quality of decision support over brevity — bounded by decision size
  (§2 honors minor/standard/major).

**Neutral**:

- The routing table remains a fallback; the six-verb vocabulary and the
  lifecycle order are unchanged — only whether a *fixed literal* or an
  *evidence-based proposal* is the default completion output.
- `designer` (future L3) inherits the pattern by **copying** the
  contract (ADR-0010 §5), not importing it.
- Implementation is trigger-driven; ADR status does not change runtime
  behavior until PR-B+ wire it.

## Alternatives Considered

All options were scored on the 9-axis matrix (decisive axes
본질 / 근본; workload deliberately excluded per the project decision
methodology). The orchestrator and the Codex peer evaluated
independently; first-principles file reading then corrected the
factual base both had used.

### O1 — New `active-guidance-contract.md` reference

A fresh `_shared/reference` for the next-action proposal + auto
multi-axis trigger. **Rejected**: `entry-routing-contract.md` already
owns this charter (its Routing Recommendation, Decision Prompt Shape,
and Anti-patterns are verbatim this problem) and is already consulted
by `start` + `decide`. A new file creates two sources of truth —
weaker on 근본 / 유지보수.

### O2 — New fourth "guidance" skill category

**Rejected**: ADR-0021/0022 fix the skills taxonomy at three categories
(verb / macro / meta). Guidance is none; a fourth category erodes the
taxonomy on first use (the failure ADR-0022 rejected for meta
commands). Weak on 표준 / 정석 / 근본.

### O3 — Fold active guidance into `/engineer:start` only

**Rejected** on 본질: this is the *status quo* — the contract is
already consulted only at `/engineer:start`. The reported weakness is
specifically in standalone verb invocations, which ADR-0012 condition 3
("engineer alone is sufficient") covers. Leaving single verbs with a
fixed completion literal leaves the weakness in place.

### O4 — Promote the 9-axis registry to a cross-verb service, leave completion literals unchanged

**Rejected** on 본질: addresses W2 but leaves W1 — the fixed completion
literal — in place. **Folded in** as §2 (registry-sharing mechanism) on
top of §1 (the completion-proposal fix) rather than taken alone.

### O5 — New plugin (`plugins/workflow` L2) or new L4 profile

**Rejected**: ADR-0010 §6 separation triggers all fail, and ADR-0020
already rejected `plugins/workflow` (Alternatives §B) as premature
extraction.

### Correction note (process transparency)

The first draft of this ADR asserted the contract was "orphaned (0
consumers)" and that the file needed CR→LF normalization. Both claims
came from subagent/peer reports adopted without first-party
verification, and both were **disproven** by direct file reads before
this ADR was finalized: the contract is consulted at
`commands/start.md:282` + `skills/decide/SKILL.md`, and the file is
already LF (CR=0). The diagnosis was corrected to "enforcement reaches
`/engineer:start` but not standalone verbs," the false hygiene section
was removed, and the host-asymmetry claim was downgraded out of scope.
This note is retained so a future reader sees the decision rests on the
verified state, not the first pass.

### Amendment 2026-08-08

Three passages in this ADR attribute the `decide-registry` host asymmetry
to a **Codex auto-activated skill mode**: the §Context parenthetical
("Codex's auto-activated `decide` falls back to the in-code default"), the
§3 boundary ("the command-mode vs auto-activated `decide-registry` reach
difference is ADR-0013 territory"), and the References entry for ADR-0013.
Their original text is preserved above; this amendment qualifies all three
rather than rewriting them.

**What was measured (2026-08-08, Codex CLI `0.147.0`):**

- Every one of the ten `plugins/engineer/skills/*/agents/openai.yaml`
  files sets `policy.allow_implicit_invocation: false` — zero absent, zero
  non-`false`. The Codex binary parses `allow_implicit_invocation`,
  `policy.allow_implicit_invocation`, and `agents/openai.yaml`, so the key
  is honored rather than decorative. **There is no auto-activated mode for
  these skills to fall back from.**
- A Codex agent shell exposes no plugin-root variable:
  `CLAUDE_PLUGIN_ROOT`, `CLAUDE_PLUGIN_DATA`, `PLUGIN_ROOT` and
  `PLUGIN_DATA` all read empty. `${PLUGIN_ROOT}` substitution exists only
  for hook commands, which do receive it. So the documented
  `$CLAUDE_PLUGIN_ROOT/scripts/decide-registry.mjs` invocation resolves to
  an empty path on a Codex skill mention.
- `decide-registry.mjs` and `skills/decide/references/decision-axes.yml`
  are both present and runnable inside the Codex install. The script is
  reachable; what fails is building its path from an unset variable.

**What changes and what does not.** The conditional rule — when the
resolver is not reachable, keep the decisive axes and read the YAML — is
sound and stays. Its stated reason is replaced across the contract and the
five verb SKILLs with the measured one, plus a pointer to the Codex
install root already documented in `skills/checkpoint/SKILL.md`, which
narrows the fallback from "always on Codex" to "only when the path cannot
be built". The scope-out stands: ADR-0013 still owns the absent Codex
command file that would run this resolution automatically. It does not own
filesystem or CLI reachability, and the three passages above should be read
with that distinction.

## References

- [ADR-0010](0010-plugin-boundary-policy.md) — §5 cross-plugin import
  ban; §6 plugin separation triggers (all fail → engineer-internal
  home).
- [ADR-0012](0012-omcc-removal-preconditions.md) — condition 3
  ("engineer alone is sufficient") covers standalone verb usage, which
  is exactly the surface §1 fixes.
- [ADR-0013](README.md#status) — Codex command-schema deferral; owns
  the registry-resolution host asymmetry kept out of scope here.
- [ADR-0020](0020-engineer-integrated-workflow-umbrella.md) —
  `/engineer:start` lifecycle macro (already consults the contract);
  rejected `plugins/workflow` L2; `VALID_VERBS` fixed at six.
- [ADR-0021](0021-codex-command-surface-parity-via-skill-wrappers.md)
  / [ADR-0022](0022-engineer-meta-skill-category.md) — three-category
  skills taxonomy (no guidance slot).
- [ADR-0024](0024-runtime-operator-control-plane.md) — no-raw-output /
  pointer-only boundary the proposal state must honor.
- [ADR-0027](0027-decide-skill-multi-axis-evolution.md) — the 9-axis
  registry (`decide-registry.mjs`, `decision-axes.yml`) §2 promotes to
  a cross-verb resolver.
- `plugins/engineer/skills/_shared/references/entry-routing-contract.md`
  — the contract this ADR extends; consulted at `start.md:282`,
  `skills/start/SKILL.md:31`, `skills/decide/SKILL.md`.
- Memory: `project_weak_active_guidance_layer`,
  `project_entry_routing_contract_enforcement_gap` (records the
  verified finding — the contract reaches `/engineer:start` but not
  standalone verbs), `feedback_decision_methodology_quality_axes`,
  `feedback_user_value_terms`.
