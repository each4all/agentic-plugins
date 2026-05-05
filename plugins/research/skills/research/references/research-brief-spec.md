# Research Brief Spec

The research brief is the **durable handoff artifact** produced by the
research skill. Topic-bound, organized around investigation
sub-questions, reusable across future workflows.

This spec defines the canonical structure, citation conventions, and
audit checklist for the brief file (`research_brief.md` per the rules
in `skills/research/references/output-file-rules.md`).

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

## Ensemble Label Policy

When the research skill runs in command-invoked mode, the bidirectional
research-scan ensemble (per
`skills/research/references/ensemble-protocol.md`, which calls peer-host
CLIs through `companions/contract.md` v0.1.1) may contribute claims and
sources. The brief artifact does NOT carry any source-of-discovery
labels:

- No host-named markers anywhere in the brief — none of `[local]`,
  `[peer]`, `[both]`, or any host-specific equivalent.
- Numeric `[N]` citations remain the only labeling format in
  Findings and Sources.
- The peer's internal citation labels are NEVER copied verbatim into
  the brief — they are remapped to the brief's capture-order
  numbering by Citation Remapping (canonical rule in
  `skills/research/references/ensemble-protocol.md`).

The presence or absence of ensemble execution must NOT be inferable
from reading the brief. Ensemble status (unavailable, partial,
degraded) is communicated only in the user-facing completion summary
that follows the save, never inside the brief artifact.

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
      `[local]` / `[peer]` / `[both]` and any host-specific equivalents
      must not appear.
- [ ] **Every PEER-ONLY claim resolved** — when command-invoked mode
      ran the bidirectional ensemble, every claim originating only
      from the peer host was either Path A (locally verified,
      `[N]`-cited) or Path B (moved into Open Questions / Gaps without
      citing the unverified source). Bare PEER-ONLY claims are forbidden.
