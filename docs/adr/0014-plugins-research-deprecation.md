# ADR-0014: plugins/research deprecation — capability folded into plugins/engineer:investigate cited-brief profile

## Status

Superseded by [ADR-0015](0015-research-archive-timeline-collapse.md) — timeline portion only

> **Timeline reversed by [ADR-0015](0015-research-archive-timeline-collapse.md).**
> The capability decision (deprecate `plugins/research`, fold into
> `plugins/engineer:investigate --profile=cited-brief`) is unchanged
> and operative. The timeline (Decision §1 deprecation period, §7
> Stage 3 archive scope, Consequences "Negative"/"Neutral" bullets)
> is superseded — `plugins/research` is archived at Stage 2.5+
> rather than carried through a deprecation period. Sections marked
> with inline `(Superseded by ADR-0015 §1)` notes carry the
> reversal; the original prose is preserved as historical record.

## Context

[ADR-0010](0010-plugin-boundary-policy.md) defined the 4-layer plugin
composition model and shipped `plugins/research` as the canonical L2
capability example, with `research_brief.md` as the typed handoff
prototype. Stage 1 deliberately separated research from a future L3
persona to demonstrate the L2 layer's reusability. Stage 2 then
shipped `plugins/engineer` as the first L3 persona, with
`engineer:investigate` (the evidence-gathering verb) explicitly pointing
users to `/research:research` for "durable cited external evidence" via
a [cross-plugin handoff suggestion](../../plugins/engineer/skills/investigate/SKILL.md).

Stage 2 dogfood and the Phase 1 brainstorm of this ADR's parent
workflow surfaced two converging signals:

### Signal 1 — engineer:investigate's handoff suggestion is non-sticky by design

The handoff paragraph at `plugins/engineer/skills/investigate/SKILL.md`
lines 187–196 carries the explicit caveat: *"Per ADR-0010 §5, this is
informational only; no automatic invocation occurs from this skill."*
The same advisory paragraph appears, with minor phrasing variations,
in five other engineer skills (`frame`, `decide`, `compose`, `refine`,
`critique`). Composition is therefore documentation-level only — the
runtime never pulls research in on a persona's behalf. In practice,
engineer users either (a) skip the handoff because they have not
manually issued `/research:research` first, or (b) the persona handles
evidence-gathering directly inside `investigate` using
codebase-native tools (Glob/Read/Grep, agent dispatches), bypassing
research altogether.

### Signal 2 — ADR-0010 §6 plugin-separation triggers, applied inverse, do not justify research as a separate L2

[ADR-0010 §6](0010-plugin-boundary-policy.md) specifies three
triggers that promote a capability into its own plugin:

1. **Infrastructure used by 2+ other plugins** — research is not used
   as infrastructure by any other plugin. engineer references it via
   handoff suggestion only, and no second consumer has emerged.
2. **Distinct cost/quota/auth profile** — research uses WebSearch /
   WebFetch and the same companion ensemble engineer uses; no
   meaningfully different operational concern.
3. **Mental model discontinuity at install time** — Stage 1
   articulated this as "researcher's gathering activity" vs
   "developer's workflow." In practice, the gathering activity is
   what engineer users do *as part of* their developer workflow;
   the mental-model split was a conceptual prediction that field
   usage did not validate.

None of the three triggers hold, which is the same condition under
which §6 says "the capability stays internal to its current plugin."
The first L2 instance has, by its own framework's discipline, failed
the boundary test.

### Signal 3 — Stage 2.5+ candidate "plugins/research naming review" was already on the docket

[`docs/DEVELOPMENT.md`](../DEVELOPMENT.md) (lines 282–295) records a
Stage 2.5+ candidate: *"`plugins/research` naming review at the time
of Stage 3 designer plugin naming (Stage 2 user-articulated concern
that `research` retains an `omcc-research` 1:1-port shape; the same
`<persona>:<verb>` axis from ADR-0010 should re-examine the L2
capability name in light of Stage 3 evidence)."* This ADR promotes
that candidate from a rename review to a full deprecation, on the
basis that the underlying issue was not naming hygiene but the L2
boundary itself.

### Signal 4 — Stage 3 designer is likely to follow the same pattern

The pattern observed for engineer (persona handles its own
domain-specific evidence-gathering) is expected to recur for the
Stage 3 `designer` persona. Keeping `plugins/research` as a separate
L2 plugin would, by Stage 3 entry, leave the framework with two
personas neither of which composes the supposedly-shared L2
capability. Acting at Stage 2.5+ is more honest than waiting for
Stage 3 to confirm the prediction.

### Codex CLI commands integration constraint

Codex CLI 0.128.0 has no plugin-commands schema; only Claude Code
hosts the `commands/<verb>.md` slash-command path natively. Engineer's
`/engineer:investigate` works on Claude; on Codex, users invoke the
skill via `$engineer:investigate` mention only. A new cited-brief
profile inherits this asymmetry and cannot, on its own, achieve full
slash-command parity on Codex without a separate design decision —
captured by [ADR-0013 reservation](README.md) (file pending; trigger:
Stage 3+ when the Codex commands schema lands or an alternative
mechanism is selected).

## Decision

### 1. Deprecate `plugins/research` at Stage 2.5+

> **Superseded by [ADR-0015](0015-research-archive-timeline-collapse.md) §1.**
> The deprecation period prescribed below (plugin installable through
> Stage 3 entry, banner / `[DEPRECATED]` marketplace prefix, 5-skill
> rewrite-then-remove cycle) is not produced. `plugins/research` is
> archived directly at Stage 2.5+. The capability decision —
> deprecation in principle — stands; its timeline implementation is
> what changes. Original prose preserved below as historical record.

`plugins/research` enters a deprecation period at this ADR's
acceptance. Concretely:

- The plugin remains installable through Stage 3 entry. Existing
  users do not lose access mid-cycle.
- All user-facing surfaces (`README.md`, `commands/research.md`,
  `skills/research/SKILL.md`, both `plugin.json` manifests,
  `agents/openai.yaml`) carry an explicit deprecation notice that
  points to the cited-brief profile.
- Marketplace catalog entries (`.claude-plugin/marketplace.json`,
  `.agents/plugins/marketplace.json`) gain a `[DEPRECATED]` prefix
  on the description field where the schema supports one (Claude);
  Codex catalog schema currently has no per-plugin description
  field, so the deprecation signal lives in the `.codex-plugin/plugin.json`
  manifest description and the Codex skill `agents/openai.yaml`
  description. The marketplace JSON itself is unchanged on Codex
  (no schema bump in this ADR).
- The five other engineer skills (`frame`, `decide`, `compose`,
  `refine`, `critique`) rewrite their cross-plugin handoff
  suggestions to point to the cited-brief profile rather than
  `/research:research`. The `investigate` skill removes its
  handoff suggestion outright, as the cited-brief profile is now
  internal to the same skill.

### 2. Absorb the cited-brief contract into `plugins/engineer:investigate`

A new third profile, `cited-brief`, joins the existing two
(`analysis`, `root-cause`) on `engineer:investigate`. The profile
inherits the full research contract:

- **Artifact spec** — adapted from `research-brief-spec.md` (4-tier
  source taxonomy, numeric `[N]` citation system, three-marker
  sentinel discipline, 11-item audit checklist, Ensemble Label
  Policy).
- **File and sandbox rules** — adapted from `output-file-rules.md`
  (slug sanitization 7-step, output-root environment override,
  existing-directory prompt, sandbox enforcement).
- **Bidirectional ensemble** — adapted from
  `research/skills/research/references/ensemble-protocol.md` and
  surfaced as a new `research-scan` ensemble point type alongside
  engineer's existing `Explore` and `Investigate` types in
  `plugins/engineer/skills/_shared/references/ensemble-protocol.md`.
- The new contract files live under
  `plugins/engineer/skills/investigate/references/` (a new
  directory created by this absorption; engineer's existing
  per-skill references pattern follows the `_shared/references/`
  + skill-local references precedent set by other engineer
  skills).

### 3. Resolve the source-of-discovery label policy conflict

Engineer's shared ensemble protocol presents synthesis findings with
explicit `[Both]` / `[Local]` / `[Peer]` source-of-discovery labels.
Research's brief artifact strictly forbids any such labels and
requires numeric `[N]` citation only. The two policies are
incompatible at the artifact axis but orthogonal at the data axis.

The cited-brief profile resolves the conflict via dual-track
rendering:

- **Workflow phase notes** (engineer's standard
  `state.mjs append`-driven workflow `.md` body) keep the existing
  `[Both]` / `[Local]` / `[Peer]` source-of-discovery labels for
  internal orchestration transparency.
- **Brief artifact** (the saved `<root>/YYYY-MM-DD_<slug>/research_brief.md`
  the user reads) strips all source-of-discovery labels at audit
  time and keeps numeric `[N]` citations only.

Enforcement is a combination of a prose anti-pattern in the SKILL
body (forbids label leakage) and a checker test in
`tests/plugin-shape/test-engineer-plugin.mjs` that verifies a
fixture-generated brief contains zero source-of-discovery markers.

### 4. Amend ADR-0010 by consequence (not supersede)

ADR-0010's 4-layer model is preserved. The changes are local to the
sections that named research as the canonical L2 example and to §6
where the trigger discipline is now self-amended by retroactive
inverse application:

- **§1 (4-layer table)** — research row gains `(deprecated, see
  ADR-0014)` annotation. The L2 row itself remains, with `decision`
  and `image` still listed as planned future capability plugins
  whose triggers can be evaluated independently.
- **§3 (single-verb capability precedent)** — `/research:research`
  remains as the precedent that anchored the naming convention but
  acquires a footnote ("Stage 1 only — Stage 2.5 deprecated;
  precedent valid as historical record").
- **§5 (typed handoff prototype)** — the
  `research_brief.md`-as-handoff-prototype claim is amended to
  reflect that the prototype is now embedded inside
  `engineer:investigate`'s cited-brief profile rather than carried
  by a separate L2 plugin.
- **§6 (plugin separation triggers)** — a footnote records the
  inverse-application result for `plugins/research` and notes that
  this ADR is the first instance of the §6 discipline being applied
  to a *retraction* (vs. the original "when to add" framing).
- **`## Amendments` section (new)** — added at the end of ADR-0010,
  following the [ADR-0008](0008-companion-distribution-model.md)
  precedent (lines 504–546). Records `Trigger`, `Finding`,
  `Changes`, and `Verified-against` fields.
- **Last-amended footer** — `Last-amended: <date> (per ADR-0014)`
  added as the file's final line.

ADR-0010 is *not* superseded. Its 4-layer model, 6-verb model,
naming convention, plugin-separation triggers, and cross-plugin
handoff principle all remain in force.

### 5. ADR-0013 numbering hygiene

The Codex CLI commands integration mechanism is a separate problem
already named in `docs/DEVELOPMENT.md` as a Stage 2.5+ candidate.
Because the present ADR is being created before the Codex commands
ADR, [docs/adr/README.md](README.md) registers ADR-0013 as a
*reserved placeholder* (no file created). The placeholder line in
the index reads `| 0013 | Codex CLI commands integration mechanism
(file pending — Stage 3+ trigger) | Reserved |`. The ADR file
itself is created when the trigger fires (typically the moment
Codex CLI gains plugin-commands schema support, or earlier if the
project elects an alternative mechanism design).

This avoids both the convention violation of skipping a number and
the premature commitment of authoring an ADR for a problem whose
constraints are not yet stable.

### 6. Stage 2.5+ MVP statement

The cited-brief profile in this ADR addresses the *capability* gap
(persona-internal cited evidence) but does not address the *parity*
gap between Claude and Codex command surfaces. Concretely:

- **Claude Code**: `/engineer:investigate --profile=cited-brief
  <topic>` works as a slash command via the existing
  `commands/investigate.md` Phase 0/1/2 flow. State is persisted
  through `state.mjs`, the peer ensemble dispatches via
  `dispatch-peer.mjs`, the brief saves through the same audit-then-save
  pipeline absorbed from research.
- **Codex CLI 0.128.0**: `$engineer:investigate` continues to work
  as a skill mention only. The cited-brief profile is selectable
  via natural-language scope, but the slash-command-style automatic
  Phase 0/1/2 wiring requires either (a) a Codex CLI plugin-commands
  schema (upstream change) or (b) an agentic-plugins-side adapter
  mechanism designed in ADR-0013. Neither is in scope for Stage 2.5+.

The MVP statement, recorded explicitly here so users and future
agentic-plugins maintainers do not mistake the asymmetry for a
defect: **Stage 2.5+ ships Claude command-mode + Codex SKILL-only
mention; full Codex parity is deferred to ADR-0013.**

### 7. Stage 3 archive removal surfaces (explicit list)

> **Superseded by [ADR-0015](0015-research-archive-timeline-collapse.md) §1.**
> The archival surfaces enumerated below are reinterpreted as
> Stage 2.5+ scope rather than Stage 3 scope; the list itself is
> still operative as the inventory of files to remove. The
> commits implementing this archival are `28b5eb8` (plugin archive)
> and `944fd4e` (ADR-0010 cascade).

When Stage 3 entry triggers archival of `plugins/research`, the
following surfaces must be removed or migrated. Recording them here
ensures Stage 3 work does not have to rediscover them.

- `package.json` — `scripts.test:plugin-shape` invocation of
  `test-research-plugin.mjs` is removed; the test file itself moves
  to a Stage 3 archive location or is deleted.
- `.release-please-manifest.json` — `plugins/research` version
  entry removed.
- `release-please-config.json` — `packages."plugins/research"`
  block removed.
- `.claude-plugin/marketplace.json` — research catalog entry
  removed.
- `.agents/plugins/marketplace.json` — research catalog entry
  removed.
- `plugins/research/` — directory archived (location TBD at
  Stage 3; either an `archive/` sibling or git-history-only
  preservation, decided as part of Stage 3's cushion deliverable).
- `tests/plugin-shape/test-research-plugin.mjs` — removed.
- `tests/research/` — removed (or migrated if any general-purpose
  helpers prove worth retaining).

This list is descriptive of Stage 3 work, not prescriptive of
Stage 2.5+ work. Stage 2.5+ keeps every surface listed above
intact and adds deprecation signals only.

## Consequences

**Positive**:

- The composition gap (engineer's handoff suggestion is non-sticky)
  is closed at the source — engineer users get cited evidence
  without leaving their persona.
- ADR-0010 §6's plugin-separation triggers are battle-tested
  inverse: the framework's own discipline now records its first
  retraction, which strengthens the discipline's credibility.
- Stage 3 designer development has a precedent for absorbing
  evidence-gathering domain-internally rather than referencing a
  separate L2 plugin. The cited-brief profile is the template.
- `engineer:investigate` gains workflow-resume capability for
  cited-brief sessions automatically (engineer's
  `state.mjs`-backed continuity is a strict superset of research's
  in-session-only model). Long-running brief sessions survive
  context compaction.
- Marketplace install surface decreases by one entry (Stage 3
  entry effect, not immediate).

**Negative**:

- 31+ files affected across documentation, plugin source, and
  meta layers (per the Phase 2 explore in this ADR's parent
  workflow). The cascade is mechanical but broad.
- This is the first plugin retirement in agentic-plugins. The
  deprecation pattern (banner, manifest prefix, marketplace
  description, 5 cross-skill handoff rewrites, ADR amendment,
  Stage 3 archive surfaces enumeration) becomes precedent for
  future deprecations and must be implemented carefully so it can
  be followed mechanically. *(Superseded by
  [ADR-0015](0015-research-archive-timeline-collapse.md) §1: the
  banner / manifest prefix / 5-skill rewrite portion of this
  precedent is not produced. The archive-surfaces enumeration
  precedent stands, executed at Stage 2.5+.)*
- The source-of-discovery label policy conflict (engineer
  surfaces `[Both]/[Local]/[Peer]`; research brief artifact forbids
  them) requires dual-track rendering (workflow phase notes vs
  saved artifact). The mechanism is documented and tested but is
  the first instance of an artifact-axis policy diverging from
  engineer's standard ensemble synthesis vocabulary.
- Engineer:investigate gains 13 contract elements from the
  research absorption (4-tier source taxonomy, numeric citation
  system, three-marker sentinel, 11-item audit checklist, brief
  save artifact, slug sanitization, output-root override,
  existing-directory prompt, Citation Remapping, sub-question
  derivation 1–7, output language separation, web-tool
  degradation handling, stale-evidence caveat). Each addition is
  small but the aggregate increases engineer:investigate's surface
  area.

**Neutral**:

- `plugins/research` is *deprecated*, not *removed*. Existing
  installations continue to function unchanged through Stage 3
  entry. release-please continues to track the plugin's version
  through the deprecation period; no manual changelog entry is
  added by this PR (release-please generates the 0.4.0 deprecation
  release from the commit body of the deprecation commit).
  *(Superseded by [ADR-0015](0015-research-archive-timeline-collapse.md)
  §1: `plugins/research` is removed at Stage 2.5+. The `research_brief.md`
  format remains readable because the cited-brief profile preserves
  it unchanged.)*
- ADR-0010's 4-layer model and 6-verb model are unchanged. The L2
  capability slot remains, with `decision` and `image` still
  listed as planned future occupants whose triggers will be
  evaluated independently when the time comes.
- The `research_brief.md` artifact format is unchanged in shape;
  only its production locus moves (from `plugins/research` to the
  new cited-brief profile inside `plugins/engineer:investigate`).
  Existing saved briefs from the Stage 1 deprecation period remain
  readable.

## Alternatives Considered

### Approach 2 — Reframe / defer to Stage 3 evidence

Do not deprecate now; either skip ADR-0014 entirely or write a
narrow ADR that reframes `plugins/research` as a standalone
cited-artifact utility. Wait for Stage 3 designer to confirm the
pattern (or refute it) before acting.

**Rejected because**: the relevant evidence is already inside the
codebase. `engineer:investigate`'s own SKILL self-evidence ("no
automatic invocation occurs") and the inverse application of
ADR-0010 §6's three triggers both point the same direction;
designer is unlikely to overturn either signal. Deferring would
keep an extra install surface live, leave engineer's handoff
suggestion dangling, and force Stage 3 to absorb the same
re-examination work that this ADR performs proactively. The
deferral's only honest justification — "wait for stronger evidence"
— is unsupported because the evidence threshold has been crossed.

### Approach 3 — Immediate archive + supersede ADR-0010

Skip the deprecation period; archive `plugins/research` immediately
and supersede ADR-0010 with a new model ADR that either drops the
L2 layer entirely or redefines it.

**Rejected because**: (a) immediate archive violates the
deprecation lifecycle convention practiced across the JavaScript /
Python / browser-plugin ecosystems and would surprise any external
user who installed `plugins/research` during Stage 1; (b) the L2
layer is not actually empty after research's removal — `decision`
and `image` are still planned occupants whose §6-trigger
evaluation will run on its own merits; superseding the layer
itself would invalidate those plans without independent
justification; (c) an ADR-0010 supersede is a much larger
amplitude change than the evidence supports — Phase 1 brainstorm
explicitly weighed the supersede approach against the amend
approach and found that amend-by-consequence preserves more
correct framework state while addressing the actual finding.

### Override candidates within the chosen Approach 1

During Phase 1 brainstorm, the (a)/(b)/(c)/(d) bundle was checked
for individual override potential. The findings:

- **(b) Stage 3-only deferral or immediate archive** — both
  incoherent with (c) `amend by consequence`: a deferred
  deprecation makes the amendment premature, and an immediate
  archive makes it under-scoped (the layer's other occupants
  are still relevant).
- **(c) Supersede or leave alone** — supersede inherits Approach
  3's amplitude problem; leave-alone leaves invalid references
  that ADR-0014 cannot rationally compose around.
- **(d) ADR-0013 first** — would have been the rational override
  trigger if the cited-brief profile required new Codex command
  mechanics. Phase 3 plan-verify confirmed that the Stage 2.5+
  MVP statement (Claude command-mode + Codex SKILL-only mention)
  closes the question without ADR-0013 needing to land first.

The bundle survives the override checks unmodified, which is
recorded in the parent workflow's Phase 1 decision frontmatter.
