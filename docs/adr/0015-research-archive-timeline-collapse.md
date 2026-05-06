# ADR-0015: Research archive timeline collapse — supersedes ADR-0014 timeline portion

## Status

Accepted

## Context

[ADR-0014](0014-plugins-research-deprecation.md) decided two
separable things:

- **(A) Capability decision** — `plugins/research` is deprecated and
  its cited-brief contract is absorbed into
  `plugins/engineer:investigate` as the `cited-brief` profile.
- **(B) Timeline** — the deprecation runs the lifecycle prescribed by
  Decision §1: plugin remains installable through Stage 3 entry,
  user-facing surfaces carry deprecation banners and `[DEPRECATED]`
  prefixes, the five other engineer skills rewrite their handoff
  suggestions to point at the cited-brief profile, archival happens
  at Stage 3 entry per §7's enumerated surfaces.

(A) was decided correctly and is unaffected by this ADR. (B) was
decided on a Phase-1 brainstorm reasoning chain that this ADR
re-examines and reverses.

### What Phase 1 reasoning got wrong on (B)

ADR-0014's Phase 1 brainstorm rejected Approach 3 (immediate archive
\+ ADR-0010 supersede) on three grounds, the first of which was:

> (a) immediate archive violates the deprecation lifecycle convention
> practiced across the JavaScript / Python / browser-plugin
> ecosystems and would surprise any external user who installed
> `plugins/research` during Stage 1.

The convention referenced (Python PEP 387, Chrome Manifest
deprecation lifecycle, JavaScript ecosystem norms) presupposes a
specific premise: **installed users whose migration must be
protected**. That premise is the load-bearing reason for the
deprecation period.

agentic-plugins has no public release, no documented downstream
consumers, and no installed user base — the premise does not obtain
in this scope. Phase 1 reasoning applied the convention reflexively
without checking whether its premise applied. The convention is
therefore not load-bearing here, and the deprecation period it
prescribes is procedure without protective effect: banner work,
dual-track marketplace entries, and cross-skill caveat updates that
nobody would see.

This was knowable at Phase 1 brainstorm time. No new evidence has
emerged since. What this ADR records is **a re-weighting of
existing evidence after the original reasoning was tested against
implementation reality during Deliverable D** — a decision-quality
correction, not a fact change.

### Why a new ADR rather than an Amendment to ADR-0014

The ADR convention (Nygard 2011, ThoughtWorks Tech Radar guidance)
distinguishes two ADR-evolution mechanisms:

- **Amendment**: clarifications, sub-finding additions, downstream
  cascades that follow from the original Decision. The original
  Decision section's prose remains accurate; the Amendment adds
  context.
- **Supersede (new ADR)**: Decision-section reversals. The original
  Decision section's prose is no longer accurate; readers must be
  pointed at the new ADR for the operative decision.

ADR-0014's Decision §1 ("plugin remains installable through Stage 3
entry"), Consequences "Negative" bullet ("becomes precedent for
future deprecations" with banner / manifest prefix / 5-skill
rewrite scope), and "Neutral" bullet ("deprecated, not removed")
are all reversed by this decision. That is a Decision-section
reversal, which the convention assigns to Supersede.

This ADR therefore supersedes ADR-0014's timeline portion (B) and
sets the precedent that future ADR Decision-section reversals in
agentic-plugins use Supersede, not Amendment. The convention is
codified in [`docs/adr/template.md`](template.md) as a guideline
for future ADR authors.

### Override candidate (b) revisited

ADR-0014 Phase 1 also considered override candidate (b) "Stage
3-only deferral or immediate archive" within Approach 1, and rejected
it on the ground that "an immediate archive makes [the ADR-0010
amendment] under-scoped (the layer's other occupants are still
relevant)."

That rejection conflated two scopes: the *plugin* scope (which is
what gets archived) and the *layer* scope (whose other occupants
remain relevant). Archiving `plugins/research` does not
under-scope the ADR-0010 amendment because the amendment's job is
to record the L2 layer's state and its planned occupants
(`decision`, `image`), neither of which depends on whether
`plugins/research` is in deprecation period or already archived.

Phase 1's (b) rejection was reasoning under the same
mis-framing as the Approach 3 (a) rejection — applying a procedural
intuition (lifecycle convention, scope-of-amendment) without
checking whether the procedural premise held in this scope. This
ADR's Decision below is operationally identical to what (b) would
have selected; what is new is the explicit acknowledgement that
Phase 1 reasoning over-weighted procedural convention.

## Decision

### 1. Timeline — collapse to immediate archive at Stage 2.5+

`plugins/research` is archived at Stage 2.5+ rather than carried
through the deprecation period prescribed by ADR-0014 Decision §1.
Concretely:

- **§1 deprecation period is skipped.** Banner work, `[DEPRECATED]`
  marketplace prefixes, dual-track marketplace catalog entries —
  all obsolete and not produced.
- **§7 (Stage 3 archive removal surfaces) is reinterpreted as
  Stage 2.5+ scope.** The enumerated archival surfaces
  (`package.json`, `release-please-*`, marketplace catalogs,
  `plugins/research/` directory, `tests/plugin-shape/test-research-plugin.mjs`,
  `tests/research/`) execute at Stage 2.5+ rather than Stage 3.
- **§1's cross-skill handoff rewrite scope is reduced.** The five
  engineer skills (`frame`, `decide`, `compose`, `refine`,
  `critique`) **remove** their `/research:research` references
  outright rather than rewriting them to point at the cited-brief
  profile, because the cited-brief profile is in-persona and
  needs no external advisory.

The implementation lands in commits `28b5eb8` (plugin archive) and
`944fd4e` (ADR-0010 cascade). This ADR records the decision that
authorizes those commits' shape.

### 2. What this ADR does *not* change

- **ADR-0014 §2 (cited-brief absorption)** is unchanged. The
  capability decision — `plugins/research`'s contract folded into
  `plugins/engineer:investigate --profile=cited-brief` — stands.
  Implementation in commit `4077552`.
- **ADR-0014 §3 (source-of-discovery label policy)** is unchanged.
  Workflow phase notes keep `[Both]/[Local]/[Peer]` labels; the
  saved brief artifact strips them.
- **ADR-0014 §4 (ADR-0010 amend by consequence)** is unchanged in
  principle. ADR-0010 is amended (cited as a cascade of *this* ADR
  rather than ADR-0014's Amendment), and its 4-layer model, 6-verb
  model, naming convention, plugin-separation triggers, and
  cross-plugin handoff principle remain in force.
- **ADR-0014 §5 (ADR-0013 numbering hygiene)** is unchanged.
- **ADR-0014 §6 (Stage 2.5+ MVP statement — Claude command-mode +
  Codex SKILL-only mention)** is unchanged.

### 3. Operational distinction from rejected Approach 3

ADR-0014 rejected Approach 3 for three bundled reasons. This ADR
selects only the timeline component from that bundle and explicitly
retains the other rejection grounds:

| Approach 3 component | This ADR | Rationale |
|---|---|---|
| Immediate archive | Adopted | Phase 1 over-weighted lifecycle convention; convention's premise (installed users) does not obtain |
| ADR-0010 *supersede* (full layer redefinition) | Rejected (unchanged from ADR-0014) | 4-layer model and §6 trigger discipline survive intact; superseding amplitude exceeds evidence |
| Drop L2 capability slot | Rejected (unchanged from ADR-0014) | `decision`/`image` remain planned occupants whose §6-trigger evaluation runs on its own merits |

The decision is therefore "Approach 1 with the timeline component
replaced by Approach 3's archive schedule," not "return to Approach
3." Approach 1's framework-state preservation (ADR-0010 amend, L2
slot kept) is intact.

### 4. ADR-0014 disposition

ADR-0014's Status changes to `Superseded by ADR-0015`. Inline
supersede markers are added to ADR-0014's affected sections
(Decision §1, §7, Consequences "Negative" bullet, "Neutral" bullet)
pointing readers to this ADR for the operative decision. The
original prose remains in ADR-0014 as historical record per
standard ADR convention; readers landing on ADR-0014 directly are
warned at the top of the file and at each affected section.

ADR-0014's existing in-place Amendment (added during Deliverable D
implementation) is removed by this ADR — the Amendment's content
is subsumed by this ADR's Decision and Context, and keeping a
parallel Amendment alongside a Supersede would be duplication.

### 5. Convention codification

Future ADR Decision-section reversals in agentic-plugins use
Supersede (new ADR), not Amendment. The discriminator is whether
the original Decision section's prose remains operatively accurate.

This convention is added as a guideline note to
[`docs/adr/template.md`](template.md) and reaffirmed in
[`docs/adr/README.md`](README.md). The rule does not retroactively
invalidate ADR-0008's existing Amendments (additive clarifications)
or ADR-0010's existing Amendment (cascade following from this ADR).

## Consequences

**Positive**:

- ADR audit trail records the Decision-section reversal at the right
  granularity. A reader scanning the index sees that ADR-0014's
  timeline portion was reversed; landing on ADR-0014 directly hits
  inline supersede markers; landing on ADR-0015 gets the operative
  decision.
- Phase 1 brainstorm reasoning is explicitly checked against
  implementation reality, with the over-weighting acknowledged.
  This raises the standard for future ADR brainstorming: a
  procedural intuition should be checked against whether its premise
  applies in scope, not applied reflexively.
- Convention codification (`Amendment for clarification/cascade,
  Supersede for Decision reversal`) gives future ADR authors a
  clear discriminator instead of a judgment call.
- The deprecation-period work that would have been visible to no
  audience (banner, dual-track marketplace, rewrite-then-remove
  cross-skill churn) is not produced. Stage 3 entry conditions
  remain unaffected.

**Negative**:

- The research deprecation cluster grows from one ADR to three
  (0014 capability + 0015 timeline + 0010 cascade). Readers must
  follow cross-references to assemble the full picture.
- ADR-0014 retains historical prose that is now operatively
  superseded. Inline markers reduce the risk but do not eliminate
  the possibility of a reader missing them.
- The Amendment-vs-Supersede convention requires future ADR authors
  to discriminate between additive cascades and Decision reversals.
  The discriminator (does the original Decision section's prose
  remain operatively accurate?) is reasonably objective, but edge
  cases will produce judgment calls.

**Neutral**:

- The plugins/research archival commits (`28b5eb8`, `944fd4e`) are
  unaffected by this ADR's authoring; this ADR records the decision
  that authorizes their shape, retroactively from the perspective
  of the workflow's commit ordering but not from the perspective
  of the merged history (this ADR lands in the same PR as those
  commits).
- ADR-0010's existing Amendment is rewritten to cite ADR-0015 as
  the trigger and to drop the "predictive value" framing in favor
  of "descriptive utility." The substance — that §6's trigger
  framework admits a coherent inverse reading consistent with the
  retirement decision — is preserved.

## Alternatives Considered

### A. Keep ADR-0014's in-place Amendment (no new ADR)

This was the original shape of the timeline-collapse decision
(in commits `28b5eb8` / `944fd4e`, captured as ADR-0014's
2026-05-06 Amendment).

**Rejected because**: The Amendment recorded a Decision-section
reversal under the Amendment mechanism. The justification at the
time ("no-audience condition produced the timeline collapse, and
the audit trail's strictness can be relaxed in matching scope")
relaxes framework-standard quality on the basis that no audience
will see it. agentic-plugins is positioned as a framework whose
self-development is part of its value proposition (see
[`AGENTS.md`](../../AGENTS.md) §Dogfooding); relaxing audit-trail
standards because there is no current audience contradicts that
positioning. The convention exists to make decision history
auditable for future contributors and external readers, not just
current ones.

### B. Revert the timeline collapse — restore ADR-0014's original lifecycle

Rollback commits `28b5eb8` and `944fd4e`; reintroduce the
deprecation period (banner, `[DEPRECATED]` prefix, dual-track
marketplace, cross-skill rewrite-then-remove cycle through Stage
3 entry).

**Rejected because**: The substantive finding that motivated the
timeline collapse — no installed base, no audience for the
deprecation period — is still true. Reverting would re-introduce
work whose only justification was reflexive convention application,
which Section "What Phase 1 reasoning got wrong on (B)" above
identifies as the original error.

### C. Promote to ADR-0010 supersede (Approach 3 in full)

Drop the L2 capability slot from ADR-0010, treat the layer itself
as a Stage 1 prototype that did not validate.

**Rejected because**: The L2 layer has planned occupants
(`decision`, `image`) whose §6-trigger evaluation has not yet run
and whose retirement would require independent justification.
ADR-0010's 4-layer model survives intact; its §6 trigger discipline
survives intact (it correctly diagnosed `plugins/research`'s
inverse application). Layer-level supersedure exceeds the
evidence. This is the same rejection ground ADR-0014 originally
recorded; it remains valid.

## References

- [ADR-0010](0010-plugin-boundary-policy.md) — 4-layer composition
  policy (amended as cascade of this ADR; see
  [§Amendments](0010-plugin-boundary-policy.md#amendments))
- [ADR-0014](0014-plugins-research-deprecation.md) — research
  deprecation capability decision (timeline portion superseded
  by this ADR)
- Nygard, Michael (2011) — *Documenting Architecture Decisions* —
  https://cognitect.com/blog/2011/11/15/documenting-architecture-decisions
- ThoughtWorks Technology Radar guidance — *Lightweight Architecture
  Decision Records* — https://www.thoughtworks.com/radar/techniques/lightweight-architecture-decision-records
- Python PEP 387 — *Backwards Compatibility Policy* —
  https://peps.python.org/pep-0387/
- Chrome Manifest deprecation lifecycle —
  https://developer.chrome.com/docs/extensions/develop/migrate
