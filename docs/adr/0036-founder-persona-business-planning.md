# ADR-0036: founder persona (L3) — new-business planning workbench

## Status

Proposed

> **Status convention note.** [README.md](README.md) §Process step 4
> ("Merge with `Status: Accepted`") coexists with a long-roadmap
> practice in which an ADR merges as `Proposed` and flips to
> `Accepted` in a later PR once implementation evidence lands
> (ADR-0027/0028 merged Proposed and flipped together at commit
> `24cbf1f`; ADR-0029 likewise merged Proposed in #361 and flipped in
> a follow-up PR; ADR-0030 landed `Accepted` within its introducing
> PR). ADR-0036 explicitly follows the **long-roadmap pattern**: a
> new installable L3 persona is a larger boundary decision than
> plugin-internal evolution, so the `Accepted` flip is gated on the
> Implementation Roadmap's real-topic dogfood (PR7) and lands in the
> same PR as the ADR-0010 cascade amendment. Abandonment path: if
> dogfood invalidates the direction, this ADR is marked `Deprecated`
> with a closing rationale note (the repo defines no `Rejected`
> status); if a successor redesigns part of it, the
> [README.md](README.md) §"Amendments vs Supersedes" partial-
> supersedure rules apply.

## Context

### A second persona, the first outside engineering

agentic-plugins ships one L3 persona ([`plugins/engineer`](../../plugins/engineer/),
Stage 2 per [ADR-0010](0010-plugin-boundary-policy.md)) and has long
planned a second (`designer`, per [ADR-0007](0007-migration-cutover-plan.md)
§Stage 3 and ADR-0010 §7). The user's actual second-persona demand
arrived from a different direction: **new-business planning**
(신사업 기획) — four recurring activities the user needs first-class
support for:

1. **Business-item discovery** (사업아이템 탐색) — scanning markets,
   regulations, platforms, and demand signals for candidate items
2. **Ideation** (구상) — structuring a candidate into an explicit
   problem/opportunity model
3. **Concretization** (구체화) — comparing directions under business
   constraints, drafting the artifact, evaluating it, iterating
4. **Planning composition** (기획구상) — taking one business item
   from idea to a reviewable planning package end-to-end

This is the first persona with **no omcc ancestor**. The
[ADR-0007](0007-migration-cutover-plan.md) charter scoped
agentic-plugins as an omcc replacement (engineer/designer reference
experience); the omcc→agentic-plugins cutover was declared on
2026-06-03. A business persona therefore **extends** the charter into
its first greenfield domain rather than executing a remaining stage of
it. This ADR does not alter ADR-0007's stage plan, does not displace
`designer` (which remains a future L3 candidate, consistent with
[ADR-0024](0024-runtime-operator-control-plane.md)'s correction that
the active Stage 3+ track is runtime/operator, and with `AGENTS.md`'s
"`plugins/designer` remains possible future work" stance), and does
not reopen [ADR-0012](0012-omcc-removal-preconditions.md) (all four
conditions were satisfied on 2026-06-03).

It is also the first real test of a standing claim: ADR-0010 §2 fixed
the six cognitive verbs as **universal** (necessary + sufficient for
observed knowledge work), but every shipped consumer so far is
engineering-shaped. A second persona in a non-engineering domain is
the falsification opportunity the claim has been waiting for.

### Empirical basis — the 2026-06-11 capability test

On 2026-06-11 the user ran one real business topic through the
engineer plugin as a capability probe: `engineer:investigate
--profile=cited-brief` end-to-end (sub-question decomposition,
33-source cited brief, bidirectional Claude↔Codex ensemble with real
PEER-ONLY coverage contributions — platform policy, regulatory age
limits, international-organization statistics, payment rails — and
zero conflicts), followed by `engineer:frame` (full 7-field problem
model). The verb machinery worked in the business domain without
modification. What failed was everything persona-shaped around it.

**Evidence honesty**: the test artifacts (brief, workflow file,
peer-run ledger) were deliberately deleted at user instruction after
the judgment was recorded. The findings survive as an unpersisted
authoring-session record; **this Context section is the canonical
durable restatement**, and the friction list below is the evidentiary
basis the rest of this ADR builds on.

### Friction findings F1–F7

- **F1 — Source taxonomy misfit.** The cited-brief 4-tier source
  taxonomy (`official-docs` / `standards` / `academic` / `secondary`,
  per [cited-brief-spec.md](../../plugins/engineer/skills/investigate/references/cited-brief-spec.md)
  §Source Type Taxonomy) is software-shaped. Market-research
  authority sources — survey institutes (Pew-class), government
  statistics and official disclosures, market-intelligence vendors —
  all collapse into `secondary`, and the `standards` tier is
  meaningless for business topics. Business needs its own authority
  tiers.
- **F2 — Decision-axis misfit.** The decide registry's axes
  ([decision-axes.yml](../../plugins/engineer/skills/decide/references/decision-axes.yml),
  per [ADR-0027](0027-decide-skill-multi-axis-evolution.md)) are
  engineering-quality axes (standards / recommendation /
  canonical-precedent / essence / foundation / extensibility /
  maintainability / maturation / practical-fit). Business decision
  axes — market attractiveness, willingness-to-pay, competitive
  intensity, regulatory exposure, unit economics, safety risk — are
  absent. The test progressed to the step just before `decide`, so
  the misfit is confirmed at the boundary where it would bite.
- **F3 — Git/commit presumption.** The engineer lifecycle assumes a
  code deliverable: the HEAD-moved auto-archive gate
  ([ADR-0017](0017-stage25-continuity-and-schema-roadmap.md)
  §sub-decision 5) never closes for a workflow whose deliverable is
  not a commit, forcing manual archive; and a code repo's transient
  `output/` directory is an awkward home for business artifacts.
- **F4 — Task Profile misfit.** The Task Profile fields
  (`scope` / `layers` / `risks` per the engineer
  [orchestration.md](../../plugins/engineer/skills/_shared/references/orchestration.md)
  Step 1) are meaningless for business topics. The cited-brief SKILL
  already marks them "descriptive only"; a business persona
  generalizes that misfit to all six verbs.
- **F5 — Trigger-phrase misfit.** Skill descriptions and trigger
  phrases are code-centric ("codebase", "bug", …), so auto-routing
  quality for business intents is poor. Persona-level triggers and
  descriptions are needed.
- **F6 — Positive: the verb machinery is domain-agnostic.** The
  cited-brief machinery — sub-question decomposition, citation
  contract, conflict rules, PEER-ONLY routing, bidirectional
  ensemble — worked for business research unmodified, with the peer
  contributing real coverage. This validates the direction this ADR
  takes: **reuse the machine; replace the persona-shaped data**.
- **F7 — Ensemble-template misfit.** The ensemble point templates
  ([ensemble-protocol.md](../../plugins/engineer/skills/_shared/references/ensemble-protocol.md))
  are code-anchored (Explore = "Analyze the codebase
  architecture…"), requiring manual adaptation for business framing.
  Persona-owned per-verb ensemble templates are needed.

### Forces

- ADR-0010 §5 forbids cross-plugin imports; §6 defines plugin
  separation triggers; §7 fixes the L3 naming axis (persona noun,
  `-er` preferred). [ADR-0029](0029-entry-routing-contract-enforcement.md)
  §Neutral already records the second-persona reuse rule: a future
  L3 "inherits the pattern by **copying** the contract (ADR-0010 §5),
  not importing it."
- [ADR-0027](0027-decide-skill-multi-axis-evolution.md) §1 made the
  axis-registry schema deliberately portable ("can adopt the same
  schema verbatim without re-deciding axis semantics") while keeping
  the reader engineer-local, and pre-committed the L2 question:
  "When (and if) an L2 `decision` plugin lands (per ADR-0010 §1
  Layer 2 planned occupants list, gated by §6 trigger 1 — second
  consumer plugin needing the registry), the migration requires a
  fresh ADR" deciding the migration mechanics.
- The workflow machinery is already **sibling-copied**, not shared:
  engineer and orchestrator each carry their own `state.mjs`
  (~3.6k-line divergence), `dispatch-peer.mjs`, `peer-runner.mjs`
  (near-copy, ~63 changed lines), `stop-archive.mjs`, and
  `session-handoff.mjs`. [ADR-0024](0024-runtime-operator-control-plane.md)'s
  `plugins/runtime` occupies the ADR-0010 §1 L1 slot as the
  runtime/operator primitive, but it has **not** extracted the shared
  workflow-state/hooks/broker machinery that the §1 table sketched —
  that extraction has not happened.
- The business axes named in F2 are **unvalidated**: the capability
  test stopped just before `decide`, so no business decision has
  actually been scored against them. Any design that freezes them
  into a cross-plugin contract before dogfood validates them would
  enshrine guesses.

## Decision

Introduce **`plugins/founder`** — the second L3 persona plugin — as a
new-business planning workbench, composed per the seven sub-decisions
below. The MVP is entirely L3-internal with codified extraction
seams; nothing in this ADR changes `plugins/engineer`,
`plugins/orchestrator`, or `plugins/runtime`.

### Sub-decision 1 — Persona: `founder`

The plugin name is **`founder`** (L3 persona axis per ADR-0010 §7:
persona noun, `-er` suffix, pairing with `engineer` and the planned
`designer`).

**Scope definition**: a *founder* here is **the owner of a
new-business decision** — startup founding, corporate venturing
(사내 신사업), or side-business planning — not only a startup CEO.
The name's startup lean is an accepted, recorded tradeoff.

Rejected names: `planner` (heavy plan-lexeme overload inside this
repo — `orchestrator:plan`, the plan-verify ensemble point,
`compose --profile=plan`, Phase 3 "plan" — and it undersells the
discovery/ideation half of the requirement arc) and `strategist`
(not `-er`, consultancy/executive bias, weak ownership of item
discovery). See Alternatives (c).

**Separation justification** (ADR-0010 §6): trigger 3 — install-time
mental-model discontinuity. "I'm planning a new business" and "I'm
engineering software" are different hats in the user's own
vocabulary; installing one must not require the other. Triggers 1
and 2 are not claimed.

ADR-0010 §7's "Stage 3 plugin name (planned): `designer`" language
predates this ADR and remains true — `founder` is **added** as the
second L3 persona by a cascade amendment to ADR-0010 **at this ADR's
`Accepted` flip** (not before, so ADR-0010 never cites a Proposed
decision), with `designer` preserved as a future candidate.

### Sub-decision 2 — Requirement→verb mapping and skill categories

The four requirements map onto the fixed six-verb surface
(ADR-0010 §2) plus the macro/meta categories
([ADR-0020](0020-engineer-integrated-workflow-umbrella.md) /
[ADR-0021](0021-codex-command-surface-parity-via-skill-wrappers.md) /
[ADR-0022](0022-engineer-meta-skill-category.md)):

| Requirement | Surface |
|---|---|
| 탐색 (discovery) | `founder:investigate` (business-brief profile, SD4) |
| 구상 (ideation) | `founder:frame` (business problem model, SD6) |
| 구체화 (concretization) | `founder:decide` → `founder:compose` → `founder:critique` → `founder:refine` |
| 기획구상 (planning composition) | `founder:start` lifecycle macro |

All six verbs ship with business-anchored SKILL content. No verb is
added or renamed — this is the universality test, not a verb-set
change. `founder:start` follows the **macro skill** category
(sequences verbs across phases; not a 7th verb, per ADR-0020
§Sub-decision 1). The three continuity **meta skills**
(`founder:resume` / `founder:checkpoint` / `founder:peer-now`)
mirror per ADR-0017/ADR-0022, each carrying the mandatory
Host-availability matrix (ADR-0022 §3).

**Cross-host honesty boundary**: Codex `$founder:*` skills provide
**cognitive-runbook parity**, not host-bootstrap/state parity — the
same boundary ADR-0021 records for engineer ("ADR-0021 does NOT
close that gap; it closes the cognitive runbook parity gap"),
pending ADR-0013 or an alternative mechanism.

### Sub-decision 3 — Staged composition with an extraction-ready decision seam (F2)

The MVP ships **everything L3-internal**. founder carries its own
`decision-axes.yml` using the ADR-0027 §1 portable schema verbatim
(presets / ordered axes / `id` / bilingual labels / `question` /
`role: decisive|supporting`; ≥2-decisive invariant per §1.3), read
by founder's **own reader copy** — the ADR-0029 §Neutral copy/adapt
rule, never a cross-plugin import (ADR-0010 §5).

**Initial business preset** (data, provisional until dogfood;
re-tiering is a data change, not a schema change):

| Axis | Role | Note |
|---|---|---|
| `market-attractiveness` (시장성) | **decisive** | size/growth/timing of the addressable problem |
| `unit-economics` (단위경제) | **decisive** | does a sold unit make money — the other fastest killer |
| `willingness-to-pay` (지불의사) | supporting | evidence of payment intent, not just interest |
| `competitive-intensity` (경쟁강도) | supporting | structure and saturation of alternatives |
| `regulatory-exposure` (규제노출) | supporting, **gate-style** | veto-like: an unmitigated regulatory blocker must lower confidence or route back |
| `safety-risk` (안전리스크) | supporting, **gate-style** | veto-like: user-safety/liability exposure must lower confidence or route back |

"Gate-style" reuses the established pattern of the engineer compact
preset's `entry-routing-guarantee` axis: veto semantics are encoded
in the axis **question text** (failing the gate must lower
confidence or route back), so the ADR-0027 two-role schema is
unchanged — no third `role` value is introduced.

**The seam, precisely.** A founder-local copy of the registry
pattern is **duplication evidence that a future extraction ADR will
evaluate against ADR-0010 §6 trigger 1** — it is *not yet*
"infrastructure used by 2+ other plugins" in the trigger's sense
(nothing is shared; two plugins carry sibling copies). Extraction
into the planned `decision` L2 occupant requires a fresh ADR
(ADR-0027 §1), and that ADR should fire only after founder's
business axes are **dogfood-validated** — extracting around
unvalidated axis data would freeze guesses into a cross-plugin
contract. Seam boundary fixed now so the copies stay extractable:

- **Extractable later** (mechanics): the decision request/artifact
  schema, the registry resolver + validation + scoring/weighting
  mechanics, the preset-resolution precedence ladder.
- **Permanently persona-owned** (data): axis *data* (presets,
  labels, questions, roles), source taxonomy (SD4), ensemble prompt
  templates (SD6), Task Profile fields (SD6).

### Sub-decision 4 — Business source taxonomy and evidence-quality rules (F1)

`founder:investigate --profile=business-brief` is the cited-brief
analogue, specified in founder's own `business-brief-spec.md`
(mirroring the in-persona contract precedent of
[ADR-0014](0014-plugins-research-deprecation.md) §2). Proposed
**5-tier business source taxonomy** (replaces the software 4-tier;
implementation PR may refine names/count — this ADR fixes the
principle and the starting set):

1. **official-stats** — government/IGO statistics, official filings
   and disclosures
2. **research-institutional** — survey institutes (Pew-class),
   peer-reviewed/academic, think tanks
3. **market-intelligence** — market-data vendors, industry analyst
   reports
4. **primary-field** — first-party field evidence: interviews,
   surveys, observation
5. **secondary-press** — press, blogs, community

Tier-asymmetric conflict rules mirror the cited-brief pattern
(higher tier supersedes with the lower recorded as a contradictory
data point; equal-tier conflicts presented side-by-side; material
unresolvables move to Open Questions).

Business evidence additionally requires, as first-class spec rules:

- **Freshness and jurisdiction**: market/regulatory/pricing claims
  carry as-of dates and jurisdiction tags — business data drifts
  faster than software documentation and is jurisdiction-bound.
- **Paywalled/non-public sources**: explicit citation treatment for
  inaccessible reports, summaries-of-paid-reports, vendor claims,
  and estimates that cannot be independently verified (cite as
  vendor-claim/estimate, never silently launder into a higher tier).
- **Privacy gate**: proprietary venture concepts, interview/customer
  data, and unpublished business material pass an explicit gate
  before **web search or peer-host dispatch** — mirroring the
  cited-brief ensemble's pre-dispatch privacy gate
  ([cited-brief-ensemble.md](../../plugins/engineer/skills/investigate/references/cited-brief-ensemble.md)
  §Step 1: "The privacy gate has passed for the topic AND the
  confirmed sub-questions. The gate covers BOTH web search AND
  external ensemble dispatch").

### Sub-decision 5 — Lifecycle: git-substrate MVP with an artifact-manifest seam (F3)

founder reuses the git-anchored lifecycle wholesale: branch=workflow
([ADR-0018](0018-stage3-architecture-orchestrator-and-branch-context.md)
§sub-2), schema-1.x workflow files and archive gates
([ADR-0011](0011-workflow-continuity-storage.md) /
[ADR-0017](0017-stage25-continuity-and-schema-roadmap.md)), and the
commit-terminal model of
[ADR-0028](0028-engineer-phase7-commit-automation.md) (never
auto-commit; terminal-marker-last), copied/trimmed per SD7.

**Workspace convention (recommended, not enforced)**: founder
workflows anchor to a **per-venture content git repository** —
business documents are version-controlled deliverables, and a
venture repo gives the lifecycle real commits to terminate on. The
F3 friction came from running business work inside a *code* repo;
the fix in MVP is workspace separation, not lifecycle surgery.

State home: `<repo>/.agentic-plugins/state/founder/` per
[ADR-0025](0025-workflow-storage-migration.md) §1 ("the canonical
repo-local workflow and peer-run state home"). founder adopts the
same fail-closed corruption/ambiguity posture as the existing state
readers where applicable; because founder is new, only the
canonical home exists — no legacy dual-home fallback (ADR-0025 §4
is migration-scoped) and no migration surface.

**Guard paths**: non-git directory → clear refusal with manual-init
guidance (suggest `git init` / choosing a venture repo); detached
HEAD and dirty-baseline guards mirror engineer's Phase 0 behavior.

**The F3 seam**: a non-git **artifact-manifest terminal**
(`planning-package-complete` — the lifecycle closes by writing an
artifact manifest + terminal marker instead of observing a commit)
is recorded here as the designed future relaxation for non-git
workspaces. It is **not implemented in MVP** (Non-Goal 2): it forks
the terminal state machine and weakens the branch=workflow
invariant, which is a workflow-schema decision deserving its own
ADR once real non-git demand arrives.

### Sub-decision 6 — Persona surfaces: Task Profile, triggers, ensembles, L4 profiles (F4/F5/F7)

- **Business Task Profile** (F4): founder's own `orchestration.md`
  replaces `scope`/`layers`/`risks` with business-meaningful fields —
  candidates: `Market`, `Segment`, `Stage` (idea/validation/build),
  `Risk-class`, `Evidence-confidence`. Field set is persona-owned
  data; implementation PR finalizes.
- **Persona triggers** (F5): plugin description and per-skill trigger
  phrases are business-anchored (신사업, 사업아이템, 시장조사, BM,
  기획서, business plan, market sizing, unit economics, …) so host
  auto-routing finds founder for business intents.
- **Business ensemble templates** (F7): founder ships its own
  `ensemble-protocol.md` re-anchoring all nine point types (frame,
  brainstorm, explore, plan-verify, review, root-cause investigate,
  research-scan, refine-verify, adversarial-scan) to business
  material — e.g., Explore becomes "map the market/regulatory/
  competitive landscape of {topic}" rather than "analyze the
  codebase architecture". The ensemble *mechanics* (companions
  contract v0.1.1, peer-runner supervision per
  [ADR-0023](0023-peer-runner-supervisor-layer.md)) are reused
  unchanged.
- **L4 profiles**: founder's L4 axis is **business-model/vertical
  archetypes** (e.g., `b2b-saas`, `consumer-app`, `commerce`,
  `content`), each carrying source-priority overrides, axis-weight
  overlays, and **domain guards** — non-clinical/safety/regulatory
  boundaries ride as profile *data*, not code (honesty boundaries,
  not compliance claims — Non-Goal 6). MVP ships only the `general`
  default; the profile taxonomy is explicitly deferred until demand
  arrives (ADR-0010 §1: L4 is the unbounded axis).

### Sub-decision 7 — Workflow machinery: third copy-and-trim

founder copies and trims the workflow machinery (`state.mjs`,
`dispatch-peer.mjs`, `peer-runner.mjs`, `stop-archive.mjs`,
`session-handoff.mjs`, hooks) from engineer, following the
established engineer↔orchestrator **sibling-copy pattern**
(ADR-0010 §5 no-import rule; ADR-0029 §Neutral copy/adapt rule).

**Cost honesty**: this is not free. Between the existing siblings,
`peer-runner.mjs` is a near-copy (~63 changed lines) but `state.mjs`
diverges by ~3.6k diff lines — **state adaptation is the dominant
implementation cost** and is sized as its own roadmap PR (PR2).
`parent-writeback.mjs` is excluded — orchestrator→founder dispatch
is a Non-Goal (3).

The third near-copy of `peer-runner.mjs`/`stop-archive.mjs`
accumulates duplication evidence toward an eventual **L1
workflow-runtime extraction** — the shared workflow-state/hooks/
broker machinery the ADR-0010 §1 table sketched for an L1
`runtime`, machinery that `plugins/runtime` (the ADR-0024 L1
runtime/operator primitive) deliberately has **not** absorbed; it
is the operator control-plane. That extraction, like the decision seam, requires
its own fresh ADR evaluated against §6 trigger 1; this ADR only
feeds it evidence.

### Non-Goals

1. **No `decision` L2 extraction** — fresh ADR required (ADR-0027
   §1), gated on dogfood-validated business axes (SD3).
2. **No git-optional / artifact-manifest terminal in MVP** — seam
   recorded only (SD5).
3. **No orchestrator→founder dispatch** — extending the ADR-0019
   cross-plugin invocation contract to a second target persona is a
   future ADR.
4. **No plugin-name aliases** (e.g., `/biz:` → `/founder:`) —
   ADR-0011 §Stage 2 Non-Goals item 9 stands.
5. **No artifact-noun skill sprawl** (`business-plan`, `pitch-deck`
   as skills) — ADR-0010 §3 forbidden patterns stand; artifacts are
   compose outputs, profiles, or arguments.
6. **No professional-advice guarantees** — domain guards (SD6) are
   honesty boundaries; founder does not produce legal, financial,
   tax, or clinical advice and must say so when adjacent.

## Consequences

**Positive**:

- The four business-planning requirements get a first-class,
  installable surface mapped onto the existing verb taxonomy.
- The 6-verb universality claim (ADR-0010 §2) gets its first
  non-engineering validation vehicle; F6 already supplies positive
  evidence that the underlying machinery transfers.
- The decision-L2 question stops being hypothetical: founder's
  registry copy is the concrete second-consumer evidence the future
  extraction ADR (ADR-0027 §1) will evaluate.
- The L4 profile mechanism is exercised beyond engineering
  (business-model archetypes + domain guards as data).
- The persona ships without touching engineer/orchestrator/runtime —
  zero regression surface on existing plugins at MVP time.

**Negative**:

- A **third sibling copy** of the workflow machinery raises
  maintenance and drift cost; `state.mjs` adaptation is the dominant
  implementation expense (SD7). Accepted consciously under the
  existing pattern; the copies feed the L1 extraction case.
- The business axes are **unvalidated until dogfood**; early
  decisions may be scored against imperfect axes. Mitigated by
  keeping axes persona-local data behind the seam (SD3) — re-tiering
  is cheap, and nothing upstream depends on them yet.
- F3 is only **partially resolved**: a git workspace remains a
  prerequisite in MVP. Non-git demand waits on the SD5 seam.
- Business-domain risk surface (stale market data, jurisdiction
  drift, proprietary-data leakage) is real; SD4's freshness/
  jurisdiction/privacy rules are load-bearing, not decorative.

**Neutral**:

- `designer` remains a future L3 candidate; this ADR neither
  advances nor retires it (consistent with ADR-0024 and the
  AGENTS.md inventory language).
- This is a **charter extension**, not a charter change — ADR-0007's
  scope and stage history are untouched.
- Pending cascades, named so they are not forgotten: the ADR-0010
  amendment (second L3 persona record) lands with the `Accepted`
  flip (PR7); `AGENTS.md` / `docs/ARCHITECTURE.md` inventory updates
  land with implementation PRs.
- Cross-persona collaboration (e.g., founder handing a planning
  package to engineer for build feasibility) already works through
  typed artifact files per ADR-0010 §5 — no new contract is needed
  for artifact-level handoff.

## Alternatives Considered

1. **L3-only MVP without a codified seam** — same shipping shape,
   no extraction-boundary contract. Rejected: the seam costs only
   ADR prose now, while a vague boundary makes the future
   decision-L2 ADR re-litigate what is extractable; both ensemble
   sides converged on staged-with-seams as the front-runner.
2. **Co-extract `decision` L2 in this ADR** — honor §6 trigger 1 at
   the moment the second consumer materializes (the kit/discovery
   precedent). Rejected: the trigger's subject is *shared
   infrastructure*, which does not yet exist (sibling copies are
   not sharing); ADR-0027 §1 explicitly requires a fresh ADR for
   the migration; and extracting around dogfood-unvalidated axes
   would freeze guesses into a cross-plugin contract while turning
   a persona ADR into a framework refactor of `engineer:decide`.
3. **Name `planner` or `strategist`** — `planner` pairs naturally
   with 기획자 and was the Codex peer's recommendation, but
   collides with the repo's dense plan lexeme (`orchestrator:plan`,
   plan-verify, `--profile=plan`) and undersells
   discovery/ideation; `strategist` breaks the `-er` pattern and
   carries consultancy/executive bias with weak ownership of item
   discovery. User selected `founder` with the scope definition in
   SD1.
4. **Git-optional lifecycle now** (peer-favored in brainstorm) —
   first-class non-git workspaces with an artifact-manifest
   terminal in MVP. Rejected for MVP: it forks the terminal state
   machine and weakens branch=workflow (ADR-0018 §sub-2) — a
   workflow-schema decision that deserves its own ADR under real
   non-git demand; the dominant near-term user runs in git anyway.
   The seam (SD5) preserves the path.
5. **Business as an L2 capability** (e.g., a `business-research`
   capability plugin) — rejected: the four requirements span the
   full verb arc (investigate through start), which is the
   definition of a workbench/persona, and install-time intent
   ("I'm planning a business") is persona-shaped (§6 trigger 3),
   not activity-shaped.
6. **Absorb business as engineer L4 profiles**
   (`engineer:investigate --profile=business-brief`, …) — rejected:
   it buries a distinct install-time hat inside the engineering
   persona (violates the §6 trigger-3 finding), collides trigger
   phrases (F5) inside one plugin description, and leaves every
   engineering-shaped anchor (Task Profile, lifecycle, ensemble
   templates) in place — the capability test showed those anchors,
   not the verbs, are what misfit.

## Implementation Roadmap

Indicative 7-PR ladder; implementation-session discretion on
splitting/merging. Proceeds under `Proposed` per the Status note;
every PR is gated by the standard CI surface (`npm test`,
`lint:plugin-shape`, `validate:marketplace`, `validate:versions`,
`validate:artifacts`).

- **PR1 — scaffold (atomic)**: `plugins/founder/` manifests
  (`.claude-plugin/plugin.json`, `.codex-plugin/plugin.json`),
  both marketplace catalog entries, `release-please-config.json`
  package key + `.release-please-manifest.json` entry, CHANGELOG/
  README, `tests/plugin-shape/test-founder-plugin.mjs` **plus the
  explicit `package.json` `test:plugin-shape` wiring** (the script
  enumerates files; a new test does not run without it). Atomic
  because `validate-marketplace` requires catalog entries to
  resolve to real plugin directories and manifests.
- **PR2 — workflow machinery copy-trim**: `state.mjs`,
  `dispatch-peer.mjs`, `peer-runner.mjs`, `stop-archive.mjs`,
  `session-handoff.mjs`, hooks (SessionStart / PreCompact / Stop;
  Codex `/hooks` review-trust follow-up noted per the runtime
  attestation convention). The dominant-cost PR (SD7).
- **PR3 — investigate + frame**: business-brief profile +
  `business-brief-spec.md` (tiers, freshness/jurisdiction,
  paywalled rules, privacy gate) + business Task Profile.
- **PR4 — decide + compose**: founder `decision-axes.yml` + reader
  copy + gate-style axes; compose profiles for planning artifacts.
- **PR5 — critique + refine** + the nine business ensemble point
  templates.
- **PR6 — start macro + meta skills** (resume / checkpoint /
  peer-now with Host-availability matrices).
- **PR7 — real-topic dogfood → `Accepted` flip**, in the same PR:
  ADR-0010 cascade amendment (second L3 persona), `AGENTS.md` /
  `docs/ARCHITECTURE.md` inventory updates, and — if dogfood
  invalidates instead — the `Deprecated` closing note per the
  Status section.

## References

- [ADR-0007](0007-migration-cutover-plan.md) — charter this ADR extends beyond
- [ADR-0010](0010-plugin-boundary-policy.md) — 4-layer composition, 6 verbs, naming, §5 no-import, §6 triggers, §7 L3 naming
- [ADR-0011](0011-workflow-continuity-storage.md) / [ADR-0017](0017-stage25-continuity-and-schema-roadmap.md) — workflow schema, archive gates, meta commands
- [ADR-0014](0014-plugins-research-deprecation.md) / [ADR-0015](0015-research-archive-timeline-collapse.md) — in-persona profile-borne contract precedent (cited-brief)
- [ADR-0016](0016-cross-package-commit-splitting.md) — release-please routing (implementation PRs)
- [ADR-0018](0018-stage3-architecture-orchestrator-and-branch-context.md) — branch=workflow invariant; sub-decision ADR shape
- [ADR-0019](0019-cross-plugin-invocation-contract.md) — cross-plugin dispatch contract (Non-Goal 3 boundary)
- [ADR-0020](0020-engineer-integrated-workflow-umbrella.md) / [ADR-0021](0021-codex-command-surface-parity-via-skill-wrappers.md) / [ADR-0022](0022-engineer-meta-skill-category.md) — macro/meta skill categories, cross-host parity boundary
- [ADR-0023](0023-peer-runner-supervisor-layer.md) — peer-runner supervision (reused mechanics)
- [ADR-0024](0024-runtime-operator-control-plane.md) — runtime = L1 operator control-plane (workflow-runtime machinery not absorbed)
- [ADR-0025](0025-workflow-storage-migration.md) — canonical state home + fail-closed read semantics
- [ADR-0027](0027-decide-skill-multi-axis-evolution.md) — portable axis-registry schema; fresh-ADR requirement for L2 migration
- [ADR-0028](0028-engineer-phase7-commit-automation.md) — commit-terminal model founder copies
- [ADR-0029](0029-entry-routing-contract-enforcement.md) — copy/adapt (not import) second-persona rule
- Engineer persona artifacts referenced as patterns:
  [cited-brief-spec.md](../../plugins/engineer/skills/investigate/references/cited-brief-spec.md),
  [cited-brief-ensemble.md](../../plugins/engineer/skills/investigate/references/cited-brief-ensemble.md),
  [decision-axes.yml](../../plugins/engineer/skills/decide/references/decision-axes.yml),
  [orchestration.md](../../plugins/engineer/skills/_shared/references/orchestration.md),
  [ensemble-protocol.md](../../plugins/engineer/skills/_shared/references/ensemble-protocol.md)
- 2026-06-11 capability test — authoring-session record; artifacts
  deleted at user instruction; this ADR's Context is the durable
  restatement
