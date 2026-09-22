# Business-Brief Spec (founder:investigate `business-brief` profile)

The business-brief is the **durable handoff artifact** produced by
`founder:investigate --profile=business-brief`. Topic-bound, organized
around investigation sub-questions, reusable across future founder
workflows and other founder verbs (`/founder:frame`, `/founder:decide`,
`/founder:compose`, `/founder:critique`, `/founder:refine`).

This spec defines the canonical structure, source taxonomy, evidence-
quality rules, citation conventions, the privacy gate, and the audit
checklist for the brief file (`business_brief.md` per the rules in
`output-file-rules.md`).

It is founder's own in-persona contract (ADR-0036 SD4), the business
analogue of the engineer cited-brief spec. founder carries its **own
copy** rather than importing engineer's — per ADR-0010 §5 (no
cross-plugin imports) and ADR-0029 §Neutral (copy/adapt, not import).
The software 4-tier source taxonomy (`official-docs` / `standards` /
`academic` / `secondary`) was the F1 misfit this spec replaces: market
authority sources collapse into `secondary` and `standards` is
meaningless for business topics. The five business tiers below are the
fix.

---

## Brief Structure

```markdown
# Business Brief: [topic]

## Topic Info
- Topic: [the business question as the user phrased it, normalized to a single concise statement]
- Date: YYYY-MM-DD
- Stage: idea | validation | build
- Jurisdiction(s): [the market geographies in scope — e.g., KR, EU, US; or "global" / "unspecified"]
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
citation OR is explicitly marked with one of the allowed sentinels (see "Audit Checklist").
Market / pricing / regulatory claims carry an as-of date and jurisdiction tag inline
(see "Freshness and Jurisdiction").]

### Sub-question 2: [...]
[...]

## Sources
[1] [source title — concise; fall back to URL hostname + path tail if no title found]
    URL: [full URL]
    Accessed: YYYY-MM-DD
    Tier: official-stats | research-institutional | market-intelligence | primary-field | secondary-press
    As-of: [the date the underlying data describes, when it differs from Accessed — e.g., "2024 survey", "Q3-2025 filing"; omit if not time-bound]
    Jurisdiction: [geography the source data applies to — e.g., KR, EU, US, global; omit if not jurisdiction-bound]
    Access-note: [public | paywalled | summary-of-paid-report | vendor-claim | estimate — see "Paywalled and Non-Public Sources"; omit when "public"]

[2] [primary-field entry — first-party field evidence has no public URL; use the field shape instead]
    Evidence-ID: [stable anonymized handle — e.g., "INT-03", "SURVEY-A"]
    Method: [interview | survey | observation | pilot]
    Collected: YYYY-MM-DD
    Sample: [anonymized segment + size — e.g., "5 finance leads, 50–200-seat EU startups"]
    Tier: primary-field
    Jurisdiction: [geography the evidence applies to; omit if not jurisdiction-bound]
    Consent-note: [confirmation that the cited finding is an anonymized aggregate; NO raw identities, quotes-with-PII, or contact data]

[3] [...]

[Sources are numbered in research-execution capture order — first source captured
becomes [1], next new source becomes [2], etc. Do not renumber on edits.
URLs are deduplicated — same canonical URL appears once even if cited multiple times.
primary-field entries are deduplicated by Evidence-ID rather than URL.]

## Open Questions / Gaps
- [Question or evidence gap that this brief did NOT resolve, with reason]

## Confidence Note
- Overall confidence: HIGH | MEDIUM | LOW
- Caveats: [Tied to source quality and freshness — e.g., "market-size figure rests on a
  single market-intelligence vendor estimate (vendor-claim); no official-stats corroboration"]
```

The brief is a single self-contained document. Downstream founder verbs
that consume business briefs know this shape via the ADR-0010 §5 typed
handoff prototype.

---

## Source Type Taxonomy (5 tiers)

Replaces the software 4-tier taxonomy (F1). Listed highest-authority
first; the asymmetry drives conflict resolution and confidence weight.

1. **official-stats** — government and inter-governmental-organization
   statistics, official filings and disclosures (national statistics
   offices, central banks, regulators, court/registry filings, listed-
   company disclosures, IGO datasets — OECD, World Bank, Eurostat, UN).
2. **research-institutional** — survey institutes (Pew-class),
   peer-reviewed / academic publications, established think tanks and
   research institutes. Independent, methodologically transparent.
3. **market-intelligence** — commercial market-data vendors and
   industry analyst reports (Gartner/Forrester-class, niche market-data
   firms, trade-association reports). Authoritative but commercial —
   methodology is often partial and figures are frequently vendor
   estimates (see "Paywalled and Non-Public Sources").
4. **primary-field** — first-party field evidence gathered for this
   investigation: customer/expert interviews, surveys you ran,
   direct observation, pilot data. High relevance, low external
   verifiability — treat as evidence the founder controls, not as
   independently auditable fact.
5. **secondary-press** — press, trade media, blogs, community forums,
   social posts. Lowest tier; useful for signals, leads, and
   sentiment, weakest for hard figures.

Higher-tier sources carry more weight in confidence ratings. A figure
backed only by `market-intelligence` or `secondary-press` must not be
presented with the same certainty as one corroborated by
`official-stats`.

**Collection priority**: prefer `official-stats` and
`research-institutional` for hard numbers (market size, demographics,
regulation, macro trends); use `market-intelligence` for industry-
specific sizing and competitive structure (flagging vendor estimates);
use `primary-field` for demand and willingness-to-pay signals that no
public source carries; fall back to `secondary-press` for leads,
recency, and sentiment, marking it accordingly.

### Primary-field citation shape

`primary-field` evidence has **no public URL** — interviews, surveys,
observation, and pilot data are first-party and not retrievable by a
third party. The "every source has a URL" expectation that governs the
other four tiers does NOT apply; primary-field entries use the field
shape shown in the Sources block above (`Evidence-ID`, `Method`,
`Collected`, `Sample`, `Jurisdiction`, `Consent-note`) instead of a URL.
Two load-bearing rules:

- **Anonymized aggregates only**: a primary-field citation backs an
  anonymized aggregate finding ("4 of 5 interviewed finance leads cited
  X"), never a raw quote-with-PII, identity, or contact record. The
  privacy gate covers primary-field data the same way it covers the
  topic and sub-questions — raw field data MUST never leave the local
  host (it is not sent to web search or the peer).
- **Local-only provenance**: primary-field evidence is data the founder
  controls. The peer ensemble (`business-brief-ensemble.md`) MUST NOT
  invent or contribute primary-field sources — the peer may only reason
  from anonymized aggregates the local host chose to include in the
  genericized prompt. A peer "interview finding" with no founder-supplied
  Evidence-ID is discarded, not added to the brief.

---

## Freshness and Jurisdiction

Business data drifts faster than software documentation and is
jurisdiction-bound. As first-class spec rules:

- **As-of dating**: every market-size, pricing, growth-rate,
  regulatory, or other time-sensitive claim carries the date of the
  underlying data (the source's `As-of`), not only the access date. A
  "2024 survey" cited in 2026 is two years stale — say so. When a claim
  rests on data older than the staleness horizon reasonable for its
  domain (regulation changes yearly; pricing quarterly; demographics
  slowly), flag it in the narrative and in the Confidence Note.
- **Jurisdiction tagging**: every market, regulatory, pricing, or
  competitive claim is tagged with the geography it applies to. A US
  figure does not transfer to a KR market without an explicit bridge.
  Cross-jurisdiction extrapolation is an inference (sentinel
  `[uncited inference]`), never a bare cited fact.
- When a sub-question's answer materially depends on a figure that is
  stale or jurisdiction-mismatched and no fresher / on-jurisdiction
  source exists, the gap moves to **Open Questions / Gaps** rather than
  being laundered into a confident finding.

---

## Paywalled and Non-Public Sources

Market intelligence is often locked behind paywalls or exists only as
vendor marketing. Explicit citation treatment (the `Access-note` field):

- **paywalled** — the report exists and is authoritative but you could
  not read the primary source in full. Cite what is publicly visible
  (abstract, press summary) and mark `paywalled`. Do NOT present
  paywalled headline figures as independently verified.
- **summary-of-paid-report** — the figure comes from a press article or
  blog *summarizing* a paid report you did not read. This is one tier
  weaker than reading the report: cite the summary's URL, mark
  `summary-of-paid-report`, and never silently promote it to the report's
  own authority tier.
- **vendor-claim** — a figure published by a party with a commercial
  interest in it (the vendor's own market-size claim, a startup's own
  TAM slide). Cite as `vendor-claim`; it is a data point, not a fact.
- **estimate** — a projection or modelled figure (analyst forecast,
  your own bottom-up estimate) that cannot be independently confirmed.
  Mark `estimate`; show the basis when known.

**Laundering prohibition**: never silently move a figure up the tier
ladder. A `vendor-claim` market size does not become an `official-stats`
fact because it was repeated in three blogs. The audit checklist
enforces this.

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

If a source has no clear title: use the page `<title>`; otherwise
`<hostname> — <last URL path segment>`; last resort the full URL.

### Access Date

ISO format `YYYY-MM-DD`. Records when the source was fetched/read
(distinct from `As-of`, the date the data describes).

---

## Conflict Handling

When two or more cited sources directly conflict on the same factual
claim, the brief presents the disagreement with citations rather than
silently choosing one source. Three resolution patterns (tier-asymmetric,
mirroring the cited-brief pattern with the 5-tier ladder above):

- **Equal-tier conflict** (both sources at the same tier or otherwise
  comparable rigor): present both with citations side-by-side and state
  the disagreement explicitly. Do not pick a winner. Example: *"Vendor
  A sizes the market at X [N1]; vendor B at Y [N2]" — both
  market-intelligence, both vendor-estimates.*
- **Tier-asymmetric conflict** (one source at a significantly higher
  tier — official-stats over market-intelligence, research-institutional
  over secondary-press): cite the higher-tier source as authoritative;
  record the lower-tier source as a contradictory data point with its
  citation, and signal in the narrative that the higher-tier source
  supersedes the lower-tier reading.
- **Unresolvable conflict** (no clear tier asymmetry, and the conflict
  materially affects a sub-question's answer): move the conflict into
  "Open Questions / Gaps" as an unresolved evidence pointer. Both
  citations remain in Sources.

Freshness and jurisdiction participate in tier asymmetry: a current
on-jurisdiction `market-intelligence` figure can outrank a stale or
off-jurisdiction `official-stats` figure for a fast-moving claim — state
the reasoning when it does.

Do NOT silently drop a source to make a conflict go away. The only
legitimate way to remove a source is when it carried zero load on any
finding.

The bidirectional ensemble's `business-brief-ensemble.md` §"CONFLICT
handling" cross-references this rule for peer-vs-local claim divergence;
the rule above governs both intra-corpus conflicts (two sources the
local host found) and cross-corpus conflicts (local source vs peer
source after Path A verification).

---

## Privacy Gate

PRIVACY GATE: proprietary venture concepts, interview/customer data, and
unpublished business material pass an explicit gate before BOTH web
search AND peer-host dispatch. This is a load-bearing rule, not
decorative — a founder's edge often *is* the unpublished concept, and a
leaked venture thesis or customer list is unrecoverable.

The gate is the business analogue of the cited-brief pre-dispatch
privacy gate and applies at the same boundary:

- **What the gate protects**: the proprietary venture concept / thesis,
  customer and interview identities and raw notes, unpublished product
  or pricing plans, internal financials, partner/term-sheet details,
  and any material the founder has not made public.
- **Where it applies**: BOTH web search queries (WebSearch / WebFetch)
  AND external peer-host ensemble dispatch (the companion prompt). Both
  are external transmission.
- **How it is satisfied**: before any external call, the topic AND the
  confirmed sub-questions are reviewed for proprietary content. Anything
  proprietary is genericized (e.g., "our AI scheduling app for clinics"
  → "AI scheduling software for healthcare providers") or removed. Only
  the genericized form leaves the local host. `primary-field` evidence
  (interviews, surveys) is cited by its findings, never by transmitting
  raw customer data externally.
- **Decline path**: if the topic cannot be genericized without losing
  the question, or the user declines, do NOT dispatch — run local-only
  or abort at scoping. The pre-redaction value MUST never leave the
  local host.

The gate is **bidirectional** — the same discipline applies whether the
local host is Claude (sending to Codex) or Codex (sending to Claude).
The `<privacy_contract>` block in the peer prompt
(`business-brief-ensemble.md`) instructs the peer to refrain from
fabricating or echoing proprietary identifiers, but the primary defense
is genericization before transmission.

---

## Domain-Adjacent Honesty Boundary

founder does not produce legal, financial, tax, or clinical advice
(ADR-0036 Non-Goal 6). When a sub-question lands in a regulated-advice
domain (a specific legal interpretation, a tax treatment, a clinical
claim), the brief reports what public sources say, tags the source tier
and jurisdiction, and states explicitly that the finding is not
professional advice and should be confirmed with a qualified
professional. This is an honesty boundary, not a compliance claim.

---

## Audit Checklist

Before saving the brief, verify:

- [ ] **Every finding has a citation OR a permitted sentinel**:
  - `[N]` citation referring to a Sources entry, OR
  - `[uncited inference]` with rationale — reserved for the model's own
    interpretation/synthesis (including any cross-jurisdiction or
    cross-segment extrapolation), NOT for factual claims attributed to
    an external source, OR
  - `[research interrupted — partial coverage]` (web tools became unavailable mid-session)
- [ ] **Every cited number `[N]` exists** as an entry in Sources.
- [ ] **Every source entry** has its tier and the tier-appropriate shape:
      URL-tiers (official-stats / research-institutional / market-intelligence /
      secondary-press) carry title (or fallback), URL, and access date;
      `primary-field` carries Evidence-ID, Method, Collected, Sample, and a
      Consent-note (no URL — see "Primary-field citation shape").
- [ ] **No raw primary-field identities** — every primary-field citation
      backs an anonymized aggregate; no quote-with-PII, identity, or
      contact record appears in the brief, and no peer-invented
      primary-field source was admitted.
- [ ] **Time-sensitive claims carry an as-of date**; stale figures flagged in narrative + Confidence Note.
- [ ] **Market / regulatory / pricing claims carry a jurisdiction tag**; no silent cross-jurisdiction transfer.
- [ ] **No tier laundering** — paywalled / summary-of-paid-report / vendor-claim / estimate sources keep their `Access-note`; none is presented at a higher authority than its tier and access-note warrant.
- [ ] **No orphan sources** — every Sources entry is cited at least once in Findings.
- [ ] **URLs deduplicated** — no two entries point to the same canonical URL.
- [ ] **Citation numbering stable** — no gaps, no duplicates, capture-order respected.
- [ ] **Sub-questions count is 1-7** and each has a corresponding Findings H3.
- [ ] **Dates are ISO `YYYY-MM-DD`** (Topic Info date and every Sources access date).
- [ ] **Confidence rating is exactly one of `HIGH | MEDIUM | LOW`** with caveats tied to source quality and freshness.
- [ ] **Open Questions section is honest** — gaps (including stale / jurisdiction-mismatched / unresolved-conflict items) surfaced, not hidden under HIGH confidence.
- [ ] **Regulated-advice findings carry the honesty-boundary note** (not legal/financial/tax/clinical advice).
- [ ] **No source-of-discovery labels** anywhere in the brief —
      `[Local]` / `[Peer]` / `[Both]` and any host-specific equivalents
      must not appear. (Workflow phase notes elsewhere may carry these
      labels; the brief artifact strips them.)
- [ ] **Every PEER-ONLY claim resolved** — when command-invoked mode ran
      the bidirectional ensemble, every claim originating only from the
      peer host was either Path A (locally verified, `[N]`-cited) or
      Path B (moved into Open Questions / Gaps without citing the
      unverified source). Bare PEER-ONLY claims are forbidden.

---

## Ensemble Label Policy

When `founder:investigate --profile=business-brief` runs in command-mode,
the bidirectional research-scan ensemble (per
`business-brief-ensemble.md`) may contribute claims and sources. The
brief artifact does NOT carry any source-of-discovery labels:

- No host-named markers anywhere in the brief — none of `[Local]`,
  `[Peer]`, `[Both]`, or any host-specific equivalent.
- Numeric `[N]` citations remain the only labeling format in Findings
  and Sources.
- The peer's internal citation labels are NEVER copied verbatim into the
  brief — they are remapped to capture-order numbering by Citation
  Remapping (canonical rule in `business-brief-ensemble.md`).

The presence or absence of ensemble execution must NOT be inferable from
reading the brief. Ensemble status (unavailable, partial, degraded) is
communicated only in the user-facing completion summary that follows the
save, never inside the brief artifact.
