# Design-Brief Spec (designer:investigate `design-brief` profile)

The design-brief is the **durable handoff artifact** produced by
`designer:investigate --profile=design-brief`. Topic-bound, organized
around investigation sub-questions, reusable across future designer
workflows and other designer verbs (`/designer:frame`,
`/designer:decide`, `/designer:compose`, `/designer:critique`,
`/designer:refine`).

This spec defines the canonical structure, source taxonomy, evidence-
quality rules, citation conventions, the privacy gate, and the audit
checklist for the brief file (`design_brief.md` per the rules in
`output-file-rules.md`).

It is designer's own in-persona contract (ADR-0042 SD2/SD4), the
design/UX analogue of the founder business-brief spec and the engineer
cited-brief spec. designer carries its **own copy** rather than importing
founder's or engineer's — per ADR-0010 §5 (no cross-plugin imports) and
ADR-0029 §Neutral (copy/adapt, not import). The business 5-tier source
taxonomy (`official-stats` / `research-institutional` /
`market-intelligence` / `primary-field` / `secondary-press`) was the
misfit this spec replaces: market-authority sources are meaningless for a
design/UX investigation, whose authority ladder runs on UX/accessibility
**standards**, established **design systems**, observed **competitor
patterns**, first-party **user research**, and the **design press**. The
five design tiers below are the fix.

---

## Brief Structure

```markdown
# Design Brief: [topic]

## Topic Info
- Topic: [the design/UX question as the user phrased it, normalized to a single concise statement]
- Date: YYYY-MM-DD
- Stage: discovery | design | evaluation
- Platform(s): [the delivery context — e.g., web (responsive), iOS, Android, desktop; viewport class; LTR/RTL; or "unspecified"]
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
Platform- or version-sensitive claims (a platform-guideline rule, a WCAG success criterion,
a design-system token) carry an as-of date and a platform tag inline (see "Freshness and
Platform Context").]

### Sub-question 2: [...]
[...]

## Sources
[1] [source title — concise; fall back to URL hostname + path tail if no title found]
    URL: [full URL]
    Accessed: YYYY-MM-DD
    Tier: standards-heuristics | design-system | competitor-reference | user-research | design-press
    As-of: [the version/edition or date the underlying guidance describes, when it differs from Accessed — e.g., "WCAG 2.2", "Material 3 (2024)", "HIG as of 2025-03"; omit if not version/time-bound]
    Platform: [the platform/context the source applies to — e.g., iOS, Android, web, cross-platform; omit if platform-neutral]
    Access-note: [public | paywalled | summary-of-paid-report | vendor-claim | unverified — see "Paywalled and Non-Public Sources"; omit when "public"]

[2] [user-research entry — first-party research has no public URL; use the field shape instead]
    Evidence-ID: [stable anonymized handle — e.g., "USABILITY-03", "INTERVIEW-A", "ANALYTICS-Q3"]
    Method: [usability-test | interview | survey | analytics | session-replay | field-observation]
    Collected: YYYY-MM-DD
    Sample: [anonymized segment + size — e.g., "6 first-time users, mobile web checkout"]
    Tier: user-research
    Platform: [the platform/context the evidence applies to; omit if platform-neutral]
    Consent-note: [confirmation that the cited finding is an anonymized aggregate; NO raw identities, screen recordings with visible customer data, or PII]

[3] [...]

[Sources are numbered in research-execution capture order — first source captured
becomes [1], next new source becomes [2], etc. Do not renumber on edits.
URLs are deduplicated — same canonical URL appears once even if cited multiple times.
user-research entries are deduplicated by Evidence-ID rather than URL.]

## Open Questions / Gaps
- [Question or evidence gap that this brief did NOT resolve, with reason]

## Confidence Note
- Overall confidence: HIGH | MEDIUM | LOW
- Caveats: [Tied to source quality, freshness, and platform fit — e.g., "the spacing
  recommendation rests on a single design-press article (design-press); no design-system
  or standards corroboration", or "competitor pattern observed on iOS only — web
  applicability [to be validated]"]
```

The brief is a single self-contained document. Downstream designer verbs
that consume design briefs know this shape via the ADR-0010 §5 typed
handoff prototype.

---

## Source Type Taxonomy (5 tiers)

Replaces the business 5-tier taxonomy, which does not fit a design/UX
investigation. Listed highest-authority first; the asymmetry drives
conflict resolution and confidence weight.

1. **standards-heuristics** — established UX, accessibility, and
   platform standards: Nielsen's 10 usability heuristics, WCAG 2.x
   (A / AA success criteria), W3C / WAI-ARIA authoring practices, and
   first-party platform human-interface guidelines (Apple HIG, Material
   Design guidelines, Fluent). Highest authority — these are the
   normative "what good looks like" principles a critique is later held
   to (SD4 lens ⇒ axis mapping).
2. **design-system** — established, publicly documented design systems
   and component libraries (Material, Carbon, Polaris, Fluent, Ant,
   Base Web) AND the project's own design-system documentation / tokens.
   Independent and methodologically transparent: a documented pattern
   with a stated rationale.
3. **competitor-reference** — UX/UI patterns observed in competitor or
   analogous production apps and sites. Authoritative as *observed
   practice* but partial: you see what a shipped product does, rarely the
   research or rationale behind it, and never whether it actually tested
   well. A prevalent pattern is a signal, not a proof.
4. **user-research** — first-party research gathered for this
   investigation: usability tests, user interviews, product analytics,
   session replays, surveys, direct field observation. Highest relevance
   to *this* product's real users, low external verifiability — treat as
   evidence the design team controls, not as independently auditable
   fact.
5. **design-press** — design blogs, trade articles, community posts, and
   conference talks (Smashing Magazine, Nielsen Norman Group articles,
   A List Apart, CSS-Tricks, platform-vendor blog posts). Lowest tier;
   useful for signals, emerging techniques, and leads, weakest as a
   normative authority.

Higher-tier sources carry more weight in confidence ratings. A design
recommendation backed only by `competitor-reference` or `design-press`
must not be presented with the same certainty as one grounded in
`standards-heuristics` or a documented `design-system` pattern —
"three competitors do it" is not a standard.

**Authority vs. relevance (the user-research exception).** The tier order
above ranks *external authority* — how independently a third party could
re-audit the source. On that axis `user-research` sits low (the team
controls it; it is not externally verifiable), which is why it is listed
fourth. But authority and relevance are different axes, and for one class
of claim they diverge: for a claim about **this product's own users'
observed behavior**, first-party `user-research` is the most *relevant*
evidence and **outranks `competitor-reference` and `design-press`
convention**. A prevalent competitor pattern does not override what this
product's users were actually observed to do. Two claim types, two
winners:

- **Normative claim** ("what pattern is correct / what rule applies") →
  `standards-heuristics` and `design-system` win (external authority).
- **Observed-behavior claim** ("what our users actually do / where they
  fail") → `user-research` wins over `competitor-reference` /
  `design-press` (first-party relevance).

The one axis that vetoes both is `standards-heuristics` **accessibility**
(WCAG A/AA): a hard accessibility requirement is never outranked by
convention, relevance, or freshness (SD4). This override is encoded in
Conflict Handling below.

**Collection priority**: prefer `standards-heuristics` and
`design-system` for normative principles (what pattern is correct, what
accessibility rule applies, what the system already prescribes); use
`competitor-reference` for prevailing convention and pattern precedent
(flagging it as observed-not-validated); use `user-research` for how
*this* product's real users actually behave — the signal no public
source carries; fall back to `design-press` for emerging techniques,
recency, and leads, marking it accordingly.

### User-research citation shape

`user-research` evidence has **no public URL** — usability tests,
interviews, analytics, and session replays are first-party and not
retrievable by a third party. The "every source has a URL" expectation
that governs the other four tiers does NOT apply; user-research entries
use the field shape shown in the Sources block above (`Evidence-ID`,
`Method`, `Collected`, `Sample`, `Platform`, `Consent-note`) instead of a
URL. Two load-bearing rules:

- **Anonymized aggregates only**: a user-research citation backs an
  anonymized aggregate finding ("4 of 6 first-time users missed the
  primary CTA"), never a raw screen recording with visible customer
  data, a named participant, PII, or a verbatim quote carrying
  identifying detail. The privacy gate covers user-research data the same
  way it covers the topic and sub-questions — raw research artifacts
  (recordings, transcripts, screenshots of real user sessions) MUST never
  leave the local host (they are not sent to web search or the peer).
- **Local-only provenance**: user-research evidence is data the design
  team controls. The peer ensemble (`design-brief-ensemble.md`) MUST NOT
  invent or contribute user-research sources — the peer may only reason
  from anonymized aggregates the local host chose to include in the
  genericized prompt. A peer "usability finding" with no local-supplied
  Evidence-ID is discarded, not added to the brief.

---

## Freshness and Platform Context

Design guidance and platform conventions drift, and they are
platform/context-bound. As first-class spec rules:

- **As-of dating**: every platform-guideline rule, accessibility success
  criterion, design-system token, or trend-based claim carries the
  version/edition or date of the underlying guidance (the source's
  `As-of`), not only the access date. A "Material 2" spacing rule cited
  after Material 3 shipped, or a WCAG 2.0 reading where 2.2 adds criteria,
  is stale — say so. When a claim rests on guidance older than the
  staleness horizon reasonable for its domain (platform guidelines revise
  yearly; accessibility standards every few years; visual trends fastest),
  flag it in the narrative and in the Confidence Note.
- **Platform tagging**: every pattern, gesture, component, or
  accessibility claim is tagged with the platform/context it applies to.
  An iOS navigation pattern does not transfer to Android or web without an
  explicit bridge; a desktop hover affordance has no touch equivalent; an
  LTR layout assumption breaks in RTL. Cross-platform transfer is an
  inference (sentinel `[uncited inference]`), never a bare cited fact.
  Accessibility standards themselves vary by context (WCAG vs EN 301 549
  vs Section 508) — tag which one a conformance claim references.
- When a sub-question's answer materially depends on guidance that is
  stale or platform-mismatched and no fresher / on-platform source
  exists, the gap moves to **Open Questions / Gaps** rather than being
  laundered into a confident finding.

---

## Paywalled and Non-Public Sources

Some design research is locked behind paywalls or exists only as vendor
marketing. Explicit citation treatment (the `Access-note` field):

- **paywalled** — the research exists and is authoritative (a paid
  Nielsen Norman Group report, a paid research subscription) but you
  could not read the primary source in full. Cite what is publicly
  visible (abstract, summary) and mark `paywalled`. Do NOT present
  paywalled headline findings as independently verified.
- **summary-of-paid-report** — the finding comes from a blog or article
  *summarizing* a paid report you did not read. One tier weaker than
  reading the report: cite the summary's URL, mark
  `summary-of-paid-report`, and never silently promote it to the report's
  own authority tier.
- **vendor-claim** — a claim published by a party with a commercial
  interest in it (a component-library vendor's "improves conversion by
  30%", a design tool's self-reported metric). Cite as `vendor-claim`; it
  is a data point, not a fact.
- **unverified** — a pattern assertion or self-reported metric that
  cannot be independently confirmed (an undocumented "best practice", a
  community claim with no study behind it). Mark `unverified`; show the
  basis when known.

**Laundering prohibition**: never silently move a source up the tier
ladder. A `competitor-reference` pattern does not become a
`standards-heuristics` rule because it is common; a `vendor-claim`
conversion figure does not become fact because three blogs repeated it.
The audit checklist enforces this.

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
(distinct from `As-of`, the version/date the guidance describes).

---

## Conflict Handling

When two or more cited sources directly conflict on the same design
question, the brief presents the disagreement with citations rather than
silently choosing one source. Three resolution patterns (tier-asymmetric,
mirroring the cited-brief pattern with the 5-tier ladder above):

- **Equal-tier conflict** (both sources at the same tier or otherwise
  comparable rigor): present both with citations side-by-side and state
  the disagreement explicitly. Do not pick a winner. Example: *"Design
  system A places the primary action bottom-right [N1]; system B
  bottom-left [N2]" — both design-system, both documented conventions.*
- **Tier-asymmetric conflict** (one source at a significantly higher
  tier — a WCAG success criterion over a competitor pattern, a documented
  design-system rule over a design-press opinion): cite the higher-tier
  source as authoritative; record the lower-tier source as a
  contradictory data point with its citation, and signal in the narrative
  that the higher-tier source supersedes the lower-tier reading. An
  accessibility standard is not overridden by a prettier competitor
  pattern.
- **Unresolvable conflict** (no clear tier asymmetry, and the conflict
  materially affects a sub-question's answer): move the conflict into
  "Open Questions / Gaps" as an unresolved evidence pointer, and note it
  as a candidate for `user-research` (test it with real users) or
  `/designer:decide`. Both citations remain in Sources.

Freshness and platform participate in tier asymmetry: a current,
on-platform `competitor-reference` can outrank a stale or off-platform
`design-system` reading for a fast-moving interaction pattern — state the
reasoning when it does. Accessibility (`standards-heuristics` WCAG) is the
exception: a hard A/AA requirement is not outranked by convention or
freshness (SD4 accessibility veto).

First-party `user-research` participates on the **relevance** axis (see
"Authority vs. relevance" above): for an **observed-behavior** claim (what
*this* product's users actually do or where they fail), a `user-research`
finding outranks a conflicting `competitor-reference` or `design-press`
convention even though it sits lower on the external-authority ladder — a
competitor's prevalent pattern is not evidence about this product's users.
For a **normative** claim ("what is correct"), the order is unchanged
(standards / design-system win). `user-research` never outranks a
`standards-heuristics` accessibility requirement (the one veto).

Do NOT silently drop a source to make a conflict go away. The only
legitimate way to remove a source is when it carried zero load on any
finding.

The bidirectional ensemble's `design-brief-ensemble.md` §"CONFLICT
handling" cross-references this rule for peer-vs-local claim divergence;
the rule above governs both intra-corpus conflicts (two sources the local
host found) and cross-corpus conflicts (local source vs peer source after
Path A verification).

---

## Privacy Gate

PRIVACY GATE: proprietary UI, unreleased features/flows, customer data
visible in screenshots, and secret-bearing frontend code pass an explicit
privacy gate before BOTH web search AND peer-host dispatch. This is a
load-bearing rule, not decorative — a product's unreleased UI, a
screenshot showing a real customer's data, or a frontend file carrying an
API key is unrecoverable once it leaves the local host.

The gate is the design/UX analogue of the founder business-brief and
engineer cited-brief pre-dispatch privacy gates and applies at the same
boundary:

- **What the gate protects**: proprietary or unreleased UI designs and
  flows, brand/design-system material not yet public, customer/user data
  visible in screenshots or session recordings, PII, internal analytics,
  and frontend code carrying secrets (API keys, tokens, internal
  endpoints).
- **Where it applies**: BOTH web/reference search queries (WebSearch /
  WebFetch) AND external peer-host ensemble dispatch (the companion
  prompt). Both are external transmission.
- **How it is satisfied**: before any external call, the topic AND the
  confirmed sub-questions are reviewed for proprietary content. Anything
  proprietary is genericized (e.g., "our unreleased two-tap checkout for
  the Acme app" → "a two-step mobile checkout flow") or removed. Only the
  genericized form leaves the local host. **Screenshots are sensitive by
  default**: a raw screenshot of a real UI is never sent to web search or
  the peer — it is described in genericized terms, or (for a same-host
  vision critique, per `design-brief-ensemble.md`) kept local. Frontend
  code is redacted of secrets before any external send. `user-research`
  evidence is cited by its anonymized findings, never by transmitting raw
  recordings or transcripts.
- **Decline path**: if the topic cannot be genericized without losing the
  question, or the material is inherently sensitive (a real customer's
  screen), run **local-only** (no web search, no peer dispatch) or abort
  at scoping. The pre-redaction value MUST never leave the local host.

The gate is **bidirectional** — the same discipline applies whether the
local host is Claude (sending to Codex) or Codex (sending to Claude). The
`<privacy_contract>` block in the peer prompt (`design-brief-ensemble.md`)
instructs the peer to refrain from fabricating or echoing proprietary
identifiers, but the primary defense is genericization before
transmission.

---

## Accessibility Honesty Boundary

designer surfaces and prioritizes *candidate* accessibility issues but
does **not** certify WCAG conformance (ADR-0042 Non-Goal 6, SD4 limits).
A brief that reviews accessibility evidence reports what the standards say
and tags the WCAG version and platform, and states explicitly that a
static reference/code review flags candidate issues (contrast, semantic
structure, alt text, visible focus styling) but **cannot certify
conformance** — focus order, keyboard traversal, and screen-reader
behavior require runtime interaction testing. This is an honesty boundary,
not a conformance claim; the brief flags and prioritizes, it does not
issue a certificate.

---

## Audit Checklist

Before saving the brief, verify:

- [ ] **Every finding has a citation OR a permitted sentinel**:
  - `[N]` citation referring to a Sources entry, OR
  - `[uncited inference]` with rationale — reserved for the model's own
    interpretation/synthesis (including any cross-platform or
    cross-context extrapolation), NOT for factual claims attributed to an
    external source, OR
  - `[research interrupted — partial coverage]` (web tools became unavailable mid-session)
- [ ] **Every cited number `[N]` exists** as an entry in Sources.
- [ ] **Every source entry** has its tier and the tier-appropriate shape:
      URL-tiers (standards-heuristics / design-system / competitor-reference /
      design-press) carry title (or fallback), URL, and access date;
      `user-research` carries Evidence-ID, Method, Collected, Sample, and a
      Consent-note (no URL — see "User-research citation shape").
- [ ] **No raw user-research identities** — every user-research citation
      backs an anonymized aggregate; no PII, named participant, or screen
      recording with visible customer data appears in the brief, and no
      peer-invented user-research source was admitted.
- [ ] **Version/platform-sensitive claims carry an as-of date**; stale guidance flagged in narrative + Confidence Note.
- [ ] **Pattern / accessibility / component claims carry a platform tag**; no silent cross-platform transfer.
- [ ] **No tier laundering** — paywalled / summary-of-paid-report / vendor-claim / unverified sources keep their `Access-note`; none is presented at a higher authority than its tier and access-note warrant.
- [ ] **No orphan sources** — every Sources entry is cited at least once in Findings.
- [ ] **URLs deduplicated** — no two entries point to the same canonical URL.
- [ ] **Citation numbering stable** — no gaps, no duplicates, capture-order respected.
- [ ] **Sub-questions count is 1-7** and each has a corresponding Findings H3.
- [ ] **Dates are ISO `YYYY-MM-DD`** (Topic Info date and every Sources access date).
- [ ] **Confidence rating is exactly one of `HIGH | MEDIUM | LOW`** with caveats tied to source quality, freshness, and platform fit.
- [ ] **Open Questions section is honest** — gaps (including stale / platform-mismatched / unresolved-conflict items) surfaced, not hidden under HIGH confidence.
- [ ] **Accessibility findings carry the honesty-boundary note** (candidate issues, not a conformance certificate).
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

When `designer:investigate --profile=design-brief` runs in command-mode,
the bidirectional reference-scan ensemble (per `design-brief-ensemble.md`)
may contribute claims and sources. The brief artifact does NOT carry any
source-of-discovery labels:

- No host-named markers anywhere in the brief — none of `[Local]`,
  `[Peer]`, `[Both]`, or any host-specific equivalent.
- Numeric `[N]` citations remain the only labeling format in Findings and
  Sources.
- The peer's internal citation labels are NEVER copied verbatim into the
  brief — they are remapped to capture-order numbering by Citation
  Remapping (canonical rule in `design-brief-ensemble.md`).

The presence or absence of ensemble execution must NOT be inferable from
reading the brief. Ensemble status (unavailable, partial, degraded) is
communicated only in the user-facing completion summary that follows the
save, never inside the brief artifact.
