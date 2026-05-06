# Cited-Brief Spec (engineer:investigate `cited-brief` profile)

The cited-brief is the **durable handoff artifact** produced by
`engineer:investigate --profile=cited-brief`. Topic-bound, organized
around investigation sub-questions, reusable across future workflows
and other engineer verbs (`/engineer:decide`, `/engineer:compose`,
`/engineer:critique`, `/engineer:refine`).

This spec defines the canonical structure, citation conventions, and
audit checklist for the brief file (`research_brief.md` per the rules
in `output-file-rules.md`).

The artifact filename is preserved as `research_brief.md` so previously
saved briefs from `plugins/research` (Stage 1) remain readable
unchanged. Per [ADR-0014](../../../../../docs/adr/0014-plugins-research-deprecation.md)
(Amendment 2026-05-06), this profile absorbs the cited-brief contract
from the now-removed `plugins/research` plugin (retired at Stage 2.5+).

---

## Brief Structure

```markdown
# Research Brief: [topic]

## Topic Info
- Topic: [the research subject as the user phrased it, normalized to a single concise statement]
- Date: YYYY-MM-DD
- Scope: [what this brief covers and explicitly excludes — 1-3 sentences]
- Source language: [dominant language of cited sources — e.g., English, Korean, mixed]
- Brief language: [the language this brief is written in]

## Sub-questions
1. [first investigation axis]
2. [second investigation axis]
3. [...]
[1-7 sub-questions; each one should be answerable with evidence]

## Findings

### Sub-question 1: [verbatim from sub-question list above]
[Synthesis of evidence relevant to this sub-question, with inline numeric citations [1][2]
referring to entries in the Sources section. Each substantive claim has at least one
citation OR is explicitly marked with one of the allowed sentinels (see "Audit Checklist").]

### Sub-question 2: [...]
[...]

## Sources
[1] [source title — concise; fall back to URL hostname + path tail if no title found]
    URL: [full URL]
    Accessed: YYYY-MM-DD
    Type: official-docs | standards | academic | secondary

[2] [...]

[Sources are numbered in research-execution capture order — first source captured
becomes [1], next new source becomes [2], etc. Do not renumber on edits.
URLs are deduplicated — same canonical URL appears once even if cited multiple times.]

## Open Questions / Gaps
- [Question or evidence gap that this brief did NOT resolve, with reason]

## Confidence Note
- Overall confidence: HIGH | MEDIUM | LOW
- Caveats: [Tied to source quality — e.g., "primary-source coverage limited to
  community/blog-tier sources for sub-question 3"]
```

The brief artifact format is identical to the Stage 1
`plugins/research` brief. This is intentional — existing briefs remain
valid, and downstream engineer verbs that consume cited briefs already
know this shape via the ADR-0010 §5 typed handoff prototype.

---

## Citation Conventions

### Numbering

- Citations use bracketed integers `[N]` inline, paired with entries in the Sources section.
- Numbering is assigned in **research-execution capture order** — the first source
  captured during research becomes `[1]`, the next new source `[2]`, etc.
  Do not renumber on edits when synthesis reorganizes the brief.
- A claim citing multiple sources lists them as `[1][2]`.
- The same source cited in N places appears as `[N]` repeated, NOT renumbered.

### URL Deduplication

Same canonical URL appears in Sources once — strip tracking parameters
and trailing-slash variations when comparing.

### Source Title Fallback

If a source has no clear title:
1. Use the page's `<title>` tag if available.
2. Otherwise: `<hostname> — <last URL path segment>`.
3. Last resort: full URL.

### Access Date

ISO format `YYYY-MM-DD`. Records when the source was fetched/read.

### Source Type Taxonomy (4 tiers)

- **official-docs** — first-party documentation from the maintainer
  (e.g., python.org, react.dev)
- **standards** — formal specifications (RFC, W3C, ECMA, ISO, POSIX, OpenAPI, IEEE)
- **academic** — peer-reviewed papers, university publications, arXiv preprints
- **secondary** — everything else: community forums, individual/company blogs,
  vendor docs not covered above. Note authority where known.

Higher-tier sources (official-docs, standards, academic) carry more
weight in confidence ratings than secondary sources.

---

## Conflict Handling

When two or more cited sources directly conflict on the same factual
claim, the brief presents the disagreement with citations rather than
silently choosing one source. Three resolution patterns:

- **Equal-tier conflict** (both sources at the same source-type tier
  or otherwise comparable rigor): present both with citations
  side-by-side and state the disagreement explicitly. Do not pick a
  winner. Example: *"Specification A states X [N1]; the published
  errata at [N2] revises this to Y."*
- **Tier-asymmetric conflict** (one source at a significantly higher
  tier — official-docs over secondary, standards over a blog post,
  current spec over an outdated revision): cite the higher-tier
  source as authoritative; record the lower-tier source as a
  contradictory data point with its citation, and signal in the
  narrative that the higher-tier source supersedes the lower-tier
  reading.
- **Unresolvable conflict** (no clear tier asymmetry, and the
  conflict materially affects a sub-question's answer): move the
  conflict into "Open Questions / Gaps" as an unresolved evidence
  pointer. Both citations remain in Sources.

Do NOT silently drop a source from the brief to make a conflict go
away. The audit checklist's "No orphan sources" rule retains both
citations as part of the audit trail; the only legitimate way to
remove a source is when it carried zero load on any finding.

The bidirectional ensemble's `cited-brief-ensemble.md` §"CONFLICT
handling" cross-references this rule for peer-vs-local claim
divergence; the rule above governs both intra-corpus conflicts
(two sources the local host found) and cross-corpus conflicts
(local source vs peer source after Path A verification).

---

## Ensemble Label Policy

When `engineer:investigate --profile=cited-brief` runs in command-mode,
the bidirectional research-scan ensemble (per
`cited-brief-ensemble.md`) may contribute claims and sources. The
brief artifact does NOT carry any source-of-discovery labels:

- No host-named markers anywhere in the brief — none of `[Local]`,
  `[Peer]`, `[Both]`, or any host-specific equivalent.
- Numeric `[N]` citations remain the only labeling format in
  Findings and Sources.
- The peer's internal citation labels are NEVER copied verbatim into
  the brief — they are remapped to the brief's capture-order
  numbering by Citation Remapping (canonical rule in
  `cited-brief-ensemble.md`).

The presence or absence of ensemble execution must NOT be inferable
from reading the brief. Ensemble status (unavailable, partial,
degraded) is communicated only in the user-facing completion summary
that follows the save, never inside the brief artifact.

**Note on engineer's wider label policy**: engineer's standard
ensemble synthesis (in `_shared/references/ensemble-protocol.md`)
presents synthesis findings with explicit `[Both]` / `[Local]` /
`[Peer]` source-of-discovery labels in **workflow phase notes** (the
`state.mjs append`-driven workflow `.md` body). The cited-brief
profile preserves those labels in workflow phase notes for internal
orchestration transparency, but the saved brief artifact strips them
before the audit gate per the rule above. This is the dual-track
rendering described in [ADR-0014](../../../../../docs/adr/0014-plugins-research-deprecation.md)
§ Decision item 3.

---

## Audit Checklist

Before saving the brief, verify:

- [ ] **Every finding has a citation OR a permitted sentinel**:
  - `[N]` citation referring to a Sources entry, OR
  - `[uncited inference]` with rationale — reserved for the model's
    own interpretation/synthesis, NOT for factual claims attributed
    to an external source, OR
  - `[research interrupted — partial coverage]` (web tools became unavailable mid-session)
- [ ] **Every cited number `[N]` exists** as an entry in Sources.
- [ ] **Every source entry** has: title (or fallback), URL, access date, source type.
- [ ] **No orphan sources** — every Sources entry is cited at least once in Findings.
- [ ] **URLs deduplicated** — no two entries point to the same canonical URL.
- [ ] **Citation numbering stable** — no gaps, no duplicates, capture-order respected.
- [ ] **Sub-questions count is 1-7** and each has a corresponding Findings H3.
- [ ] **Date field is ISO `YYYY-MM-DD`** (Topic Info date and every Sources access date).
- [ ] **Confidence rating is exactly one of `HIGH | MEDIUM | LOW`** with caveats tied to source quality.
- [ ] **Open Questions section is honest** — gaps surfaced, not hidden under HIGH confidence.
- [ ] **No source-of-discovery labels** anywhere in the brief —
      `[Local]` / `[Peer]` / `[Both]` and any host-specific equivalents
      must not appear. (Workflow phase notes elsewhere may carry these
      labels; the brief artifact strips them.)
- [ ] **Every PEER-ONLY claim resolved** — when command-invoked mode
      ran the bidirectional ensemble, every claim originating only
      from the peer host was either Path A (locally verified,
      `[N]`-cited) or Path B (moved into Open Questions / Gaps without
      citing the unverified source). Bare PEER-ONLY claims are forbidden.
