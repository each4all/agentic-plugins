# ADR-0010: Plugin boundary policy — 4-layer composition + universal cognitive verbs + naming convention

## Status

Accepted

> Last amended 2026-05-12 — see [Amendments](#amendments). 2026-05-06
> recorded the ADR-0015 cascade (`plugins/research` retirement);
> 2026-05-11 recorded the ADR-0020 cascade (lifecycle macro command
> boundary versus verb-level alias); 2026-05-12 first records the
> ADR-0021 cascade (macro skill category alongside verb skills);
> 2026-05-12 then records the ADR-0022 cascade (meta skill category
> as the third sibling of verb and macro skills, closing ADR-0021 §6
> and formalizing the `skills/<plugin>/` three-category split).

## Context

agentic-plugins shipped Stage 1 with two plugins:
[`plugins/companions`](../../plugins/companions/) (framework primitive
per ADR-0008) and `plugins/research` (single capability skill,
retired Stage 2.5+ per [ADR-0014](0014-plugins-research-deprecation.md)
\+ [ADR-0015](0015-research-archive-timeline-collapse.md); historical
state visible at commit `28b5eb8`). Stage 2 introduces the self-development plugin
([`docs/DEVELOPMENT.md`](../DEVELOPMENT.md) §Stage 2) and Stage 3 will
introduce the design-domain plugin ([ADR-0007](0007-migration-cutover-plan.md)
§Stage 3). With three or more plugins on the horizon, the framework
needs an explicit policy answering five questions:

1. **What axis divides plugins?** persona (engineer/designer), domain
   (dev/design/research), activity (build/critique), artifact
   (poster/code), or hybrid?
2. **What axis divides skills inside a plugin?**
3. **How do plugins use their skills** — command-driven, auto-delegated,
   or chained?
4. **How do plugins hand off to each other** when one plugin's output
   feeds another's input?
5. **When does a capability warrant its own plugin** vs being absorbed
   into an existing plugin?

These decisions cannot be evaluated independently. Choosing only
*persona* as the axis (e.g., `engineer` plugin owning its own research
machinery) duplicates capabilities across personas. Choosing only
*domain* (`research`, `dev`, `design`) hides the fact that the *same*
research activity differs by persona context (an engineer reading
RFCs vs a designer reading design systems). Choosing *activity*
(`build`, `critique`) fragments install UX since a workflow crosses
multiple verbs. The persona × domain dimensions are orthogonal — any
single-axis division folds the other dimension awkwardly inside.

A second tension: skill granularity. A plugin like
[omcc-designer](https://github.com/e16tae/omcc) has accumulated 25+
skills over time. ADR-0007 mandates redesign over 1:1 port, so the
question is whether to preserve that growth pattern or impose a
naming/structural discipline that prevents skill explosion. But
disciplines (UI/UX, print, brand, frontend, image-gen for design;
backend, frontend, devops, SRE for engineering) are themselves
unbounded — a hard cap on skills would push expertise out of the
plugin, and a free-for-all repeats the omcc-designer pattern.

These questions were resolved through Phase 1 brainstorming with Codex
peer-agent ensemble (5 rounds, AGREED on 4-layer composition + 6
universal cognitive verbs after Round 5 added Frame to the verb set).
Six independent industry/cognitive-science frameworks converge on a
small recurrent control loop (gather → frame → choose → make → judge →
iterate): Bloom's Taxonomy 1956, Miller's Law 1956 (channel capacity,
not ontological cap), OODA Loop (Boyd), PDCA (Deming), Double Diamond
(UK Design Council), Design Thinking (IDEO). Three industry plugin
ecosystems converge on capability + composer separation: Eclipse/OSGi
(plug-in runtime + extension points), VS Code (extension dependencies
vs extension packs), MCP (model-callable tools as separate from
agents). Two AI agent framework families demonstrate composition
explicitly: LangChain (tools + agents), OpenAI/Anthropic Tool Use
(tools as parameters into model invocation).

The pattern is **composition over inheritance** (Gamma et al. 1994):
small reusable capabilities composed into higher-level scenarios, with
configuration data carrying the difference between similar use cases.

## Decision

### 1. Plugin division — 4-layer composition

agentic-plugins extends the [ADR-0001](0001-hexagonal-architecture.md)
3-layer hexagonal model (CORE / ADAPTER / COMPANION) with an explicit
**composition axis** layered above. The 4 layers, top-down by
dependency direction:

| Layer | Role | Examples (current + planned) |
|-------|------|------------------------------|
| **L4 — Profile (sub-discipline within persona)** | Configuration data describing context-specific knowledge: source priorities, evaluation criteria, output contract, citation style, vocabulary, methodology. Unbounded — new sub-disciplines extend existing personas without adding plugins. | `engineer:{backend, frontend, devops, sre, ml, data, ...}`, `designer:{ui, print, brand, frontend, image, motion, ...}` |
| **L3 — Persona / Workbench plugin** | User-facing install unit. The user wears one persona "hat" at a time. Owns workflow orchestration. Composes capabilities through profiles. | `engineer` (Stage 2), `founder` (ADR-0036), `designer` (Stage 3) |
| **L2 — Capability plugin** | Persona-agnostic skills providing reusable activities: gather/frame/decide/compose/critique/refine on a particular kind of material. Self-serve via own commands too. | `orchestrator` (Stage 3+), `image` (ADR-0037, shipped); `research` (Stage 1, retired per ADR-0014); planned: `decision` |
| **L1 — Framework primitive plugin** | Cross-plugin infrastructure: peer-host invocation, workflow runtime, host adapters. Other plugins depend on these. | `companions` (Stage 1, current per ADR-0008), planned: `runtime` (workflow state, hooks, broker) — only when 2+ plugins prove they need it |

Dependency direction: `L4 (data) → L3 (workbench) → L2 (capabilities)
→ L1 (primitives)`. Higher layers depend on lower; lower layers have
no knowledge of higher.

### 2. Skill division — 6 universal cognitive verbs

Each persona/workbench plugin (L3) and capability plugin (L2) exposes
skills named by **canonical cognitive verb**. The verb set is fixed at
six (necessity + sufficiency demonstrated by mapping every observed
omcc-dev/omcc-designer skill into them):

| Verb | What it does | Maps from omcc-* |
|------|--------------|------------------|
| **Investigate** | Gather evidence, inspect context, scan codebase, probe references | research, omcc-dev/explore, omcc-dev/investigate |
| **Frame** | Turn evidence into a problem model: goals, constraints, audience, success criteria, risks | (implicit gap in omcc-dev — explicit fixes a real failure mode) |
| **Decide** | Select a direction under constraints, reject alternatives, commit to next action | omcc-dev/brainstorm |
| **Compose** | Produce the artifact: code, plan, brief, interface, prompt, spec, poster | omcc-dev/plan, design briefs, omcc-designer poster/social/frontend output |
| **Critique** | Evaluate an existing artifact against evidence, standards, goals, failure modes | omcc-dev/parallel-review, omcc-dev/audit, omcc-designer/design-evaluation |
| **Refine** | Apply feedback, repair defects, improve fit, iterate after critique | omcc-dev/fix |

These six are necessary (each maps to an observed activity), sufficient
(every omcc-* skill maps in), and independent (no verb is reducible to
another). Frame is included specifically because omitting it pushes
agents into a documented failure mode where evidence gathered by
Investigate is consumed by Decide without an explicit problem model
("the key thing generic research alone does not do" — Codex Round 5).

The verb count is **fixed for cognitive activities** but unrelated to
*expertise breadth* — Layer 4 profiles carry the unbounded discipline
expansion.

### 3. Naming convention

**Canonical skill name**: `<persona>:<verb>` for L3 plugins,
`<capability>:<verb>` for L2 plugins. Profile and topic flow as
arguments.

```text
/engineer:investigate --profile=backend --topic="auth token rotation"
/engineer:critique --profile=architecture --topic="payment service refactor"
/designer:compose --profile=ui --topic="onboarding flow"
/designer:critique --profile=print --topic="poster v3"
/research:research --topic="Node 24 child_process API surface"
```

**Single-verb capability plugins** (special case): when a capability
plugin's domain is naturally exactly one verb, the plugin name and
verb may collide and the canonical command becomes
`<capability>:<capability>`. The Stage 1 `plugins/research` plugin
shipped exactly this case: its only command was `/research:research`
(retired Stage 2.5+ per [ADR-0014](0014-plugins-research-deprecation.md)
\+ [ADR-0015](0015-research-archive-timeline-collapse.md); the
file's last state is at commit `28b5eb8`), and `Investigate` was
the implicit verb absorbed by the plugin name. Future capability
plugins may ship multiple verbs (`/decision:decide`,
`/decision:critique`); single-verb is a precedent, not a default.

**Verb-level sugar aliases** (within the same plugin): a plugin MAY
publish verb-level aliases that expand to a canonical verb plus a
profile/argument set at dispatch time. These are not new skills;
they expand internally inside the plugin's own command files.

Example:

```text
/engineer:audit ≡ /engineer:critique --profile=full-codebase
```

Verb-level aliases live entirely within the plugin's own namespace
and require no marketplace, validator, or manifest support.

**Plugin-name level aliases** (e.g., `/dev:investigate` ≡
`/engineer:investigate`) are NOT supported in Stage 2. The
marketplace contract on both Claude Code and Codex CLI requires
plugin name = catalog name = install-folder name = manifest name
(validator-enforced). Alternative plugin-name namespaces would
require either (a) catalog-level alias schema support added to
both host marketplaces, or (b) duplicating the plugin under a
second install. Both options are out of scope for Stage 2; see
[ADR-0011](0011-workflow-continuity-storage.md) §Stage 2 Non-Goals
item 9 for the deferral rationale.

**Forbidden naming patterns**:
- Activity nouns at plugin level (`build`, `evaluate`, `compose` as
  plugin names) — fragments install UX.
- Artifact nouns at plugin level (`poster`, `frontend`, `image-gen`
  as plugin names *unless* truly cross-persona infrastructure) —
  multiplies plugin count.
- Encoding ensemble count, model count, or perspective count in a
  skill name — those are dynamic per-call, not stable identity.
- Hyphenated noun-noun skill names that are really
  `<verb>-<artifact>` — write `<verb> --artifact <name>` instead, or
  publish as a sugar alias.

### 4. Plugin-internal skill use

Plugins follow this orchestration pattern:

- **Command-driven entry** — slash command (Claude) or `$skill`
  mention (Codex) is the visible user/host invocation surface. Each
  canonical verb has one command file at
  `plugins/<plugin>/commands/<verb>.md`.
- **Auto-delegating internals** — the skill's body may invoke peer
  models via [`companions`](../../companions/contract.md), invoke
  other capability plugins (per §5 handoff), or chain its own
  sub-steps (Investigate → Frame → Decide internally) without
  surfacing each step.
- **Explicit chains when stateful** — when sub-steps need durable
  state across host context boundaries, the chain becomes a
  workflow (per [ADR-0011](0011-workflow-continuity-storage.md), to
  be filed in the same Stage 2 deliverable as this ADR).

### 5. Cross-plugin handoff

Plugins hand off through **typed artifact files**, not through
in-process imports or runtime coupling. An artifact handoff carries:

- Source context (which plugin/skill produced it, when, with what
  inputs)
- Requested next action (the receiving plugin's verb + profile)
- Constraints (deadlines, scope, prior decisions to honor)
- Confidence and unresolved questions

The Stage 1 `research_brief.md` was the prototype — a durable cited
artifact that downstream plugins (or future invocations of the same
plugin) can consume. The contractual shape now lives in-persona at
`plugins/engineer/skills/investigate/references/cited-brief-spec.md`
per ADR-0014 §2; the original Stage 1 spec is at commit `28b5eb8`.

Runtime auto-handoff is permitted when both plugins are installed and
adapters can invoke the target cleanly. When the target plugin is not
installed, the producing plugin emits the artifact with a
"suggested next plugin" pointer instead of failing — graceful
degradation per the Stage 1 ADR-0008 precedent.

Plugin imports across plugin boundaries are **forbidden** (would
break SemVer independence). All cross-plugin contact is via artifact
files or via the `companions` peer-host invocation primitive.

### 6. Plugin separation triggers (when to add a new plugin)

A capability or workflow earns its own plugin when **any** of these
hold:

1. **Infrastructure used by 2+ other plugins** — promotes a helper
   from internal-to-one-plugin to a framework primitive (L1).
   Example: `kit/discovery/` extraction in Stage 2 Deliverable B
   when `engineer` becomes the second consumer of
   `discover-companion.mjs`. Future example: shared workflow runtime
   if Stage 3 `designer` needs the same hooks `engineer` ships.
2. **Distinct cost/quota/auth profile** — when a capability has
   meaningfully different operational concerns (e.g., image
   generation has external-API quotas, billing implications, and
   prompt-engineering complexity that engineering tooling doesn't),
   isolate so users opt in explicitly. Future example: `image`
   plugin separated from `designer` after design ships.
3. **Mental model discontinuity at install time** — when the user's
   intent at install ("I'm doing X") differs sharply from existing
   plugins' intents, the new plugin earns its place. Example:
   `research` (a researcher's gathering activity) installed
   independently from `engineer` (a developer's workflow), even
   though both involve gathering evidence — the install-time intent
   is different.

Triggers 1, 2, 3 are independently sufficient; ANY one promotes
extraction. Conversely, **none** of the three holding means the
capability stays internal to its current plugin.

### 7. Plugin name policy

Plugin names follow **Layer-appropriate axis**:

| Layer | Naming axis | Pattern | Examples |
|-------|-------------|---------|----------|
| L1 framework | infrastructure noun | concrete primitive concept | `companions`, future `runtime` |
| L2 capability | activity/domain noun | what-it-does | `orchestrator`, `image` (ADR-0037); `research` retired; future `decision` |
| L3 persona | persona noun (`-er` suffix preferred for English consistency) | who-uses-this | `engineer`, future `designer` |
| L4 profile | sub-discipline noun | hyphen-separated when needed | `backend`, `frontend`, `ui`, `print` |

Stage 2 plugin name: **`engineer`** (canonical, L3 persona axis,
no plugin-name level aliases per §3 — marketplace contract
constraint). Stage 3 plugin name (planned): `designer`. Pairing
`engineer + designer` keeps L3 axis consistent across stages and
matches the user's mental vocabulary ("엔지니어 모자/디자이너 모자",
"engineer hat / designer hat").

## Consequences

**Positive**:

- One axis policy resolves five tightly coupled questions (plugin
  axis, skill axis, plugin-internal use, plugin handoff, separation
  trigger), replacing ad-hoc per-plugin choices with framework-level
  consistency.
- 6 universal cognitive verbs anchor all plugins in the same
  vocabulary; cross-persona collaboration (engineer asking designer
  to critique a UI mock) becomes natural because both use
  `<persona>:critique`.
- Capability plugins (research) avoid duplication: engineer and
  designer both consume research without each shipping a research
  fork.
- Profile axis carries unbounded discipline expansion without skill
  explosion or plugin sprawl.
- Plugin separation triggers are explicit and testable, replacing
  judgment calls about whether to spin up a new plugin.
- Verb-level sugar aliases inside a plugin (e.g.,
  `/engineer:audit` ≡ `/engineer:critique --profile=full-codebase`)
  preserve familiar workflow names from omcc-dev where useful, all
  within the plugin's own namespace and free of marketplace
  contract concerns.
- Stage 3 design-domain plugin work has a pre-decided naming and
  composition policy — no Stage-3 axis brainstorm needed.

**Negative**:

- 4-layer model is one layer deeper than ADR-0001's 3-layer; mental
  model load increases for new contributors.
- Profile mechanism is new and unprototyped — Stage 2 will be the
  first proof; if profiles fail to carry sub-discipline differences
  cleanly, the policy may need ADR-0010-supersedure.
- Sugar alias adds one indirection at command dispatch; CLI users
  may see two paths to the same skill in `--help` output.
- 6-verb canonical naming may feel abstract for users familiar with
  omcc's `/start /fix /audit` workflow names — canonical
  `/engineer:fix` does not exist (the equivalent is
  `/engineer:refine`, optionally with a verb-level sugar alias
  `/engineer:fix` ≡ `/engineer:refine` published inside the plugin).
  Migration documentation needed at Stage 2 dogfood time.

**Neutral**:

- Capability plugins like `research` may publish a single verb
  (`/research:research`) when their domain is naturally one verb;
  this is permitted as a special case of `<capability>:<verb>` where
  capability and verb collide.
- The 6 verbs may grow if a future activity is found that none of
  the six absorbs cleanly (the verb set is fixed for *currently
  observed* cognitive activity, not eternally). Adding a 7th verb
  would be a non-breaking schema-minor change; renaming any of the
  six is breaking and requires ADR supersedure.

## Alternatives Considered

1. **Persona-only axis** (`engineer`, `designer`, `researcher`):
   rejected because researcher is a poorly-defined persona (the
   domain is bounded but the role is nebulous), and because each
   persona would duplicate research/decision/critique machinery.
   Maintenance burden compounds across personas.

2. **Domain-only axis** (`research`, `dev`, `design`): rejected
   because *the same* research activity differs by persona — an
   engineer reading RFCs vs a designer reading design systems is
   the same `Investigate` verb but a different *profile*. A pure
   domain axis would either fold persona variation inside each
   plugin (hidden complexity) or duplicate skills per persona
   (defeats the axis).

3. **Activity-only axis** (`build`, `critique`, `evaluate` as
   plugin names): rejected because workflows cross verbs naturally
   (Investigate → Frame → Decide → Compose → Critique → Refine in
   one task). Splitting plugin install per verb fragments install
   UX badly and creates handoff overhead at every verb boundary.

4. **Artifact-only axis** (`poster`, `frontend`, `code-review`):
   rejected because artifacts proliferate (poster, brochure,
   leaflet, social-post, banner, …) with high overlap; this is the
   omcc-designer pattern and its ~25-skill end state is the
   anti-example.

5. **Matrix plugins** (`engineer-research`, `designer-research`,
   `engineer-build`, `designer-build`, …): rejected because plugin
   count grows polynomially (n personas × m domains) with no
   reuse — each cell duplicates capability machinery.

6. **Namespace + tags** (one mega-plugin tagging skills with
   persona+domain metadata, dispatched at runtime): rejected
   because install UX is awkward (one plugin with everything = no
   meaningful install choice), names cease to express structure
   (the tag does), and the dispatch layer is implementation
   complexity that buys no clarity.

7. **Skill count hard cap** (e.g., max 5 skills per plugin):
   rejected because it confuses cognitive activity (bounded) with
   discipline expertise (unbounded). The verb set is fixed at 6 by
   cognitive necessity; the *profile* axis carries the unbounded
   expert breadth.

8. **`dev` as canonical L3 plugin name** (instead of `engineer`):
   rejected on six axes vs `engineer` (Layer semantic alignment,
   Stage 3 pairing, user vocabulary, noun-pattern consistency with
   `companions`/`research`, AI-agent-framework naming trends in
   CrewAI/AutoGen/Claude subagents). Plugin-name level aliases
   (e.g., `/dev:` as alias for `/engineer:`) were considered but
   rejected for Stage 2 because the marketplace contract on both
   hosts requires plugin name = catalog name = folder name =
   manifest name (validator-enforced). See ADR-0011 §Stage 2
   Non-Goals item 9 for the deferral rationale; if dogfood phase
   surfaces real demand, raise a Stage 2.5+ ADR for catalog-level
   alias support.

9. **Single ADR for plugin policy + continuity storage**: rejected
   in favor of splitting continuity Option III storage format into
   [ADR-0011](0011-workflow-continuity-storage.md). Continuity is a
   distinct decision per ADR-0007's "Stage 2 storage format
   finalization" mandate; mixing it with plugin boundary policy
   would obscure both decisions.

## References

- [ADR-0001](0001-hexagonal-architecture.md) — hexagonal layered model that this ADR extends to 4 layers
- [ADR-0003](0003-mcp-vs-companion.md) — separation of MCP tools from peer-agent companion turns; informs L1/L2 boundary
- [ADR-0006](0006-directory-layout-install-pattern.md) — per-plugin layout this ADR references
- [ADR-0007](0007-migration-cutover-plan.md) — redesign-over-port mandate for Stage 2/3
- [ADR-0008](0008-companion-distribution-model.md) — companion script distribution; provides the cross-plugin discovery precedent
- [ADR-0011](0011-workflow-continuity-storage.md) — continuity Option III storage format (companion ADR filed alongside this one)
- Bloom 1956 — cognitive taxonomy (6 levels)
- Miller 1956 — channel capacity (clarification: not ontological cap on activity types) — https://www.musanim.com/miller1956/
- OODA Loop (Boyd) — https://www.skmurphy.com/blog/2011/06/13/boyds110727/
- PDCA (Deming, Lean Enterprise Institute) — https://www.lean.org/lexicon-terms/pdca/
- NOAA Scientific Method — https://www.nesdis.noaa.gov/about/k-12-education/resources-teachers/what-the-scientific-method
- Double Diamond (UK Design Council) — https://www.designcouncil.org.uk/our-resources/the-double-diamond/
- Design Thinking (IDEO) — https://designthinking.ideo.com/faq/isnt-design-thinking-a-set-step-by-step-process
- Composition over inheritance (Gamma, Helm, Johnson, Vlissides 1994 — *Design Patterns*)
- Plugin ecosystem precedents: Eclipse/OSGi, VS Code (extension dependencies vs extension packs — https://code.visualstudio.com/api/references/extension-manifest), MCP (https://modelcontextprotocol.wiki/en/docs/concepts/tools)

## Amendments

### 2026-05-06 — research deprecation cascade (per ADR-0015)

**Trigger**: [ADR-0015](0015-research-archive-timeline-collapse.md)
acceptance, which supersedes [ADR-0014](0014-plugins-research-deprecation.md)'s
timeline portion and archives `plugins/research` at Stage 2.5+
directly. ADR-0014's capability decision (deprecate research, fold
contract into `plugins/engineer:investigate`'s cited-brief profile)
remains operative; ADR-0015 reverses only the deprecation-period
timeline. Both ADRs together produce the cascade recorded here.

**Finding**: Several specific examples and reference points in this
ADR named `plugins/research` as the canonical L2 capability, the
typed handoff prototype (`research_brief.md`), and the single-verb
capability naming precedent (`/research:research`). Those points
referenced a now-removed plugin. Three structural questions emerged
from the parent workflow's Phase 1 brainstorm (`Approach 1` chosen
with HIGH confidence):

1. **Does the L2 capability layer survive when its only Stage 1
   incumbent retires?** — Yes. §6's plugin separation triggers,
   applied inverse to `plugins/research`, were not met (no second
   consumer plugin materialized; no separate cost/quota/auth axis
   emerged; install-time intent was weak). §6's discipline admits
   a coherent inverse reading consistent with the retirement
   decision, which supports the framework's *descriptive utility*:
   §6 diagnoses why `plugins/research`'s separation is no longer
   warranted, given evidence collected during Stage 2 dogfood. The
   framework records its own first retraction without mutating its
   3-trigger taxonomy. The layer remains defined; planned occupants
   `decision` and `image` continue to be evaluated independently
   when the time comes.
2. **Does the typed handoff prototype (§5) survive the retirement
   of its prototype implementation?** — Yes. The cited-brief
   contract — `research_brief.md` shape, capture-order numeric
   citations, 4-tier source taxonomy, 12-item audit checklist
   (11 absorbed + 1 PEER-ONLY routing addition), ensemble label
   policy — is absorbed into
   `engineer:investigate`'s cited-brief profile. The prototype
   demonstrated the shape; the shape now lives in-persona at
   `plugins/engineer/skills/investigate/references/cited-brief-spec.md`
   and is exercised by the cited-brief profile's command-mode flow.
3. **Does the single-verb capability naming precedent (§3) survive
   when the precedent itself is gone?** — Yes. The
   `<capability>:<capability>` rule is named for any future
   single-verb L2 capability; the historical precedent (Stage 1
   `plugins/research` → `/research:research`) stands as
   documentation even after the plugin's removal.

**Changes** (read alongside the original Decision sections; the
original prose is preserved for decision-history audit):

- **§1 (4-layer composition)** — the Layer 2 examples table
  previously listed `research` as Stage 1 / current and `decision`,
  `image` as planned. Read this row in light of the 2026-05-06
  retirement: the L2 slot is now empty pending future occupants.
  The 4-layer model and its dependency direction are unchanged.
- **§3 (Naming convention, single-verb capability special case)** —
  read the `/research:research` example as **historical precedent**
  for the rule (Stage 1 only). The rule itself stands for any
  future single-verb L2 capability.
- **§5 (Cross-plugin handoff)** — the typed handoff prototype
  (`research_brief.md`) is no longer a *cross-plugin* artifact.
  It is now produced by `engineer:investigate --profile=cited-brief`
  inside the engineer persona. Read §5 as describing a contract
  pattern that need not be *physically* cross-plugin — the same
  contract can be in-persona when ADR-0014's analysis applies
  (handoff suggestion non-sticky by design + L2 separation
  triggers fail inverse). The prototype's contractual shape
  survives unchanged; only its production locus moved.
- **§6 (Plugin separation triggers)** — the trigger framework was
  inverse-tested against `plugins/research` in the parent
  workflow's Phase 1 brainstorm (Approach 1 evidential foundation).
  Trigger 1 (2+ consumer plugins) was unmet; Trigger 2 (distinct
  cost/quota/auth axis) was unmet; Trigger 3 (install-time intent
  separation) was weak. The framework's first inverse application
  is recorded here; the result describes why `plugins/research`'s
  separation was not warranted, not a prospective prediction made
  before the retirement decision.
- **Independent-install example prose** (research as the
  independent-install demonstration) is retired alongside the
  plugin. Future independent-install demonstrations will use
  planned L2 occupants (`decision`, `image`) when those land.

**Unchanged**:

- The 4-layer composition itself (L1 framework primitive / L2
  capability / L3 persona / L4 profile).
- The 6 universal cognitive verbs (Investigate / Frame / Decide /
  Compose / Critique / Refine).
- §3's naming convention as a rule (`<persona>:<verb>` for L3,
  `<capability>:<verb>` for L2, `<capability>:<capability>` for
  single-verb L2 special case).
- §6's plugin separation trigger framework and its 3-trigger
  taxonomy.
- §7's plugin name policy.
- All references to `plugins/companions` (L1 framework primitive),
  `plugins/engineer` (L3 persona), `plugins/designer` (planned
  L3), and `plugins/decision` / `plugins/image` (planned L2
  occupants).

**Verified-against**: ADR-0014 (capability decision, Decision §2–§7)
\+ ADR-0015 (timeline portion, Decision §1) + the parent workflow's
Phase 2 explore evidence (12 `plugins/research` surfaces enumerated,
18 `engineer:investigate` confluence points, 31 affected files
across documentation / plugin source / meta layers). The cascade
implementation lands at commits `28b5eb8` (plugin archive) and
`944fd4e` (this Amendment's first form, rewritten in the same PR
as ADR-0015's authoring).

### 2026-05-11 — ADR-0020 cascade (engineer integrated workflow umbrella)

**Trigger**: [ADR-0020](0020-engineer-integrated-workflow-umbrella.md)
acceptance, which adds `/engineer:start` as a command-only lifecycle
macro inside `plugins/engineer`.

**Finding**: §3 "Naming convention" / "Verb-level sugar aliases"
describes within-plugin verb→verb-plus-profile aliases (e.g.,
`/engineer:audit ≡ /engineer:critique --profile=full-codebase`).
`/engineer:start` is **not** such a sugar alias — it is a *lifecycle
macro command* that sequences multiple verb skill invocations through
the seven omcc-dev-equivalent lifecycle phases. ADR-0020 fixes the
boundary between the two shapes:

- **Verb-level sugar alias** (§3, unchanged): rewrites at
  command-dispatch time to a single canonical verb plus profile.
  State-mutation happens through the canonical verb.
  `/engineer:audit` canonicalizes to
  `/engineer:critique --profile=full-codebase` before
  `state.mjs create --verb critique`; the workflow file records
  `verb: critique`.
- **Lifecycle macro command** (new shape introduced by ADR-0020):
  orchestrates multiple verb skills sequentially with phase
  boundaries. Bootstraps its own workflow file with
  `workflow_type: start` (ADR-0020 §Sub-decision 5 + ADR-0011 §2
  cascade). The `verb` field tracks the current phase's primary
  verb and is updated at each phase transition. Example:
  `/engineer:start <feature>` lands in ADR-0020 PR 3.

`/engineer:start` does not extend `VALID_VERBS` (kept at the six
canonical verbs) and does not consume the verb-level alias namespace.
Future lifecycle macros (if any) follow the same shape; future
verb-level aliases continue to follow the §3 within-verb pattern.

**Unchanged**: 4-layer composition (§1), 6 cognitive verbs (§2),
naming convention (§3) for verb skills and verb-level sugar aliases,
plugin separation triggers (§6). The L2 capability slot remains
occupied by `plugins/orchestrator` (per ADR-0018 §sub-1); the
proposed `plugins/workflow` L2 plugin was evaluated and rejected in
ADR-0020 Alternatives §B against §6 separation triggers.

**Verified-against**: ADR-0020 §Sub-decision 1 + Alternatives §B +
§Implementation Roadmap PR 3.

### 2026-05-12 — ADR-0021 cascade (macro skill category)

**Trigger**: [ADR-0021](0021-codex-command-surface-parity-via-skill-wrappers.md)
acceptance, which establishes Codex-side command-surface parity for
lifecycle macros via skill wrappers. The trigger is the self-
acknowledged parity gap in
`plugins/engineer/.codex-plugin/plugin.json` `longDescription`
shipped at ADR-0020 PR 3: lifecycle macros existed on Claude
(`/engineer:start`) but had no Codex surface, and the previously-
anticipated unblocker ([ADR-0013](README.md#status), Codex CLI
plugin-commands schema) has no trigger yet. The skill primitive is
the existing Codex surface, so ADR-0021 uses it.

**Finding**: §3 "Naming convention" structured `skills/<plugin>/`
folders implicitly around `VALID_VERBS` members. ADR-0020 introduced
a non-verb command (`/engineer:start`) without a skills/ folder
counterpart, and the plugin-shape test at
`tests/plugin-shape/test-engineer-plugin.mjs` already encoded
`LIFECYCLE_MACROS = ['start']` as a separate category from `VERBS`
in anticipation of this question. ADR-0021 ratifies the split.

**Changes** (read alongside the original Decision sections; the
original prose is preserved for decision-history audit):

- **§3 (Naming convention) / §4 (Plugin-internal skill use)** —
  `skills/<plugin>/` permits two named categories:

  | Category | Folder | Naming | Source of name |
  |----------|--------|--------|----------------|
  | **Verb skill** | `skills/<verb>/` | `<persona>:<verb>` / `<capability>:<verb>` | one folder per `VALID_VERBS` member |
  | **Macro skill** | `skills/<macro>/` | `<plugin>:<macro>` | one folder per `LIFECYCLE_MACROS` entry (per ADR-0020 cascade) |

  Both categories share the same internal shape:
  `SKILL.md` (frontmatter `name: <folder>`) + `agents/openai.yaml`
  (`interface` block + `policy: allow_implicit_invocation: false`).
  Macro skills do NOT extend `VALID_VERBS` (kept at six per ADR-0020
  §Sub-decision 5) and are NOT verb-level sugar aliases (verb-level
  sugar canonicalizes to a single verb skill; macro skills sequence
  multiple verb skills across phases). Content authority follows
  the verb-skill convention: SKILL.md owns the host-agnostic
  cognitive runbook; the Claude-side `commands/<macro>.md` owns
  host bootstrap + state writes and delegates cognitive description
  to SKILL.md.

- **Meta commands (ADR-0017 cascade)** — meta commands
  (`/engineer:resume`, `/engineer:checkpoint`, `/engineer:peer-now`)
  remain command-only; whether they mirror as macro skills (or
  carry their own third category) is deferred to the ADR-0021
  follow-up PR.

**Unchanged**: 4-layer composition (§1), 6 cognitive verbs (§2),
verb-level sugar alias rules (§3), plugin-name level alias non-goal
(§3 / ADR-0011 §9 cascade), plugin-internal skill use orchestration
pattern (§4), plugin separation triggers (§6).

**Verified-against**: ADR-0021 §Decision §1–§4 + ADR-0021
Implementation Roadmap (this PR).

### 2026-05-12 — ADR-0022 cascade (meta skill category)

**Trigger**: [ADR-0022](0022-engineer-meta-skill-category.md)
acceptance, which closes ADR-0021 §6 — the deferred question of
whether the engineer plugin's three **meta commands**
(`/engineer:resume`, `/engineer:checkpoint`, `/engineer:peer-now`
per [ADR-0017](0017-stage25-continuity-and-schema-roadmap.md)
§sub-decisions 1/2/3) should also mirror as Codex skills, and how.
ADR-0021 left two paths: (a) extend the macro category or (c)
introduce a third category. ADR-0022 chose (c).

**Finding**: ADR-0021's `skills/<plugin>/` two-category split (verb
+ macro) treats `macro` as "sequences multiple verb skill
invocations across phases" (ADR-0021 §Decision §3). The three meta
commands are *single host-bootstrap operations*, not phase
sequencers — they do not rotate `verb` field, do not introduce
phase boundaries, and do not sequence verb skills. Cramming them
into `macro` erodes that definition. ADR-0022 ratifies a third
**meta skill** category alongside verb and macro.

**Changes** (read alongside the prior Decision sections and the
2026-05-12 ADR-0021 cascade entry above):

- **§3 (Naming convention) / §4 (Plugin-internal skill use)** —
  `skills/<plugin>/` permits **three** named categories (extending
  the two-row table from the ADR-0021 cascade entry):

  | Category | Folder | Naming | Source of name |
  |----------|--------|--------|----------------|
  | **Verb skill** | `skills/<verb>/` | `<persona>:<verb>` / `<capability>:<verb>` | one folder per `VALID_VERBS` member |
  | **Macro skill** | `skills/<macro>/` | `<plugin>:<macro>` | one folder per `LIFECYCLE_MACROS` entry (per ADR-0020 cascade) |
  | **Meta skill** | `skills/<meta>/` | `<plugin>:<meta>` | one folder per `META_COMMANDS` entry (per ADR-0017 cascade) |

  All three categories share the same internal shape: `SKILL.md`
  (frontmatter `name: <folder>`) + `agents/openai.yaml`
  (`interface` block + `policy: allow_implicit_invocation: false`).
  Meta skills do NOT extend `VALID_VERBS` (kept at six per
  ADR-0020 §Sub-decision 5) and are NOT macro skills (macro
  remains "multi-phase verb sequencer" per ADR-0021). Content
  authority follows the verb-skill / macro-skill convention:
  SKILL.md owns the host-agnostic cognitive runbook; the Claude-
  side `commands/<meta>.md` owns host bootstrap +
  `state.mjs` writes and delegates cognitive description to
  SKILL.md.

  Additionally, ADR-0022 §Decision §3 mandates that each meta
  SKILL.md include an explicit **Host availability** matrix
  describing which parts of the operation work on Claude vs Codex
  (e.g., Codex has no SessionStart re-injection; `peer-now` is
  symmetric via bidirectional `companions/`). This honesty
  requirement is what distinguishes ADR-0022's `meta` from a
  placeholder mirror.

**Unchanged**: 4-layer composition (§1), 6 cognitive verbs (§2),
verb-level sugar alias rules (§3), plugin-name level alias non-goal
(§3 / ADR-0011 §9 cascade), plugin-internal skill use orchestration
pattern (§4), plugin separation triggers (§6), the ADR-0021 cascade
two-row table above (preserved for decision-history audit).

**Verified-against**: ADR-0022 §Decision §1–§5 + ADR-0022
Implementation Roadmap (this PR).

### 2026-06-15 — founder, the second L3 persona (per ADR-0036)

**Trigger**: [ADR-0036](0036-founder-persona-business-planning.md)
acceptance, which ships `plugins/founder` as the **second L3 persona**
— the first L3 outside engineering, and the first with no omcc
ancestor.

**Finding**: founder validates the §1 4-layer model, the §2 six-verb
model, and the §3 `<persona>:<verb>` naming convention on a
non-engineering domain (new-business planning). The same six cognitive
verbs (Investigate / Frame / Decide / Compose / Critique / Refine) and
the ensemble point templates are re-anchored to business concerns —
markets, unit-economics, regulation, competition — per ADR-0036
§Sub-decision 6, copied rather than imported per
[ADR-0029](0029-entry-routing-contract-enforcement.md)'s single-source
discipline and §5's no-cross-plugin-import rule (founder owns its
`business-brief-spec.md` and business Task Profile, not engineer's
originals).

`designer` ([ADR-0007](0007-migration-cutover-plan.md) §Stage 3, §7)
remains a future L3 candidate — preserved, not replaced; the L3 layer
now carries two shipped occupants with room for more. The staged
decision-L2 seam — a future `decision` L2 capability that could extract
founder's business decision axes as a second consumer per §6 — is
recorded in ADR-0036 but deferred.

**Unchanged**: 4-layer composition (§1), 6 cognitive verbs (§2),
naming convention (§3), cross-plugin handoff (§5), plugin separation
triggers (§6), plugin name policy (§7).
