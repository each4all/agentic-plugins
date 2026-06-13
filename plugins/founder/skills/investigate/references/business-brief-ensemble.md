# Business-Brief Ensemble Protocol (founder:investigate `business-brief` profile)

Defines how the local host and a peer host operate as a dual-model
ensemble for the **research-scan** ensemble point — the business-brief
profile's bidirectional analog of the standard ensemble points. Activated
inside the business-brief profile's command-invoked mode to cross-validate
sub-question findings against an independent model on the peer host.

This is founder's own copy of the research-scan contract (ADR-0010 §5 no
cross-plugin import; ADR-0029 §Neutral copy/adapt). It is the business
analogue of the engineer cited-brief ensemble. The PR3 investigate verb
carries this self-contained research-scan contract directly; founder's
full `_shared/references/ensemble-protocol.md` (all nine business-anchored
point types) lands in ADR-0036 PR5 and will cross-reference this file for
the research-scan point.

The user never invokes the peer host directly. The skill orchestrates
dispatch, collection, and synthesis transparently through
`companions/contract.md` v0.1.1 (Claude → Codex via `codex-companion`,
Codex → Claude via `claude-companion`). When the peer host is not
installed or returns no usable output, the ensemble degrades silently to
local-only.

Mechanics — how to dispatch the peer companion, how to consume its JSON
envelope — live in `plugins/founder/scripts/peer-runner.mjs` for
command-managed ensembles, with `dispatch-peer.mjs` retained as the
blocking compatibility surface. This protocol describes only the
wire-level contract: what to send, what to expect back, how to synthesize.

---

## When This Protocol Applies

Activates inside the business-brief profile's command-invoked mode (Step
1 end through Step 3 entry) when invoked as:

- Claude: `/founder:investigate --profile=business-brief <topic>` (slash command)
- Codex: `$founder:investigate business-brief <topic>` (skill mention; per
  ADR-0036 SD2 cognitive-runbook parity, full slash-command parity is
  deferred to ADR-0013 reserved)

Does NOT apply to: auto-activated business-brief outside command-invoked
mode; inline cross-references from other founder skills (`frame`,
`decide`, `compose`, `refine`, `critique`); binary confirmations or
progress updates within the same session.

---

## Affinity

Per founder's always-max policy, the ensemble is **always-on** for
command-invoked business-brief sessions. The business-research domain's
quality dimensions (market breadth, source-tier requirement,
controversy, freshness, jurisdiction spread) do not map cleanly onto
file/layer/risk affinity tiers. The surface stays simple and relies on
graceful degradation when the cost would be unjustified (e.g., the peer
host CLI is not installed).

---

## Execution Pattern

Three steps per business-brief session: **Launch**, **Collect**, **Synthesize**.

### Step 1: Launch — after sub-question confirmation + scope

Pre-conditions before dispatch:

1. The privacy gate has passed for the topic AND the confirmed
   sub-questions. PRIVACY GATE: proprietary venture concepts,
   interview/customer data, and unpublished business material pass an
   explicit gate before BOTH web search AND peer-host dispatch — see
   "Privacy" below and `business-brief-spec.md` § Privacy Gate.
2. The existing-directory check (per `output-file-rules.md`) has
   completed and the user did NOT choose abort. Aborting before dispatch
   prevents wasted peer runs on a session the user will discard.

Dispatch (mechanics owned by `plugins/founder/scripts/peer-runner.mjs`;
this protocol pins shape only):

3. founder's `peer-runner.mjs run` resolves the peer-companion script
   path via the companion-cache discovery (cache-glob with
   `AGENTIC_COMPANIONS_ROOT` env override, per ADR-0008), records the
   matching `pending_ensemble` row, and creates the hidden peer-run
   ledger. If discovery fails, the ensemble degrades to local-only per
   "Failure Handling".
4. The caller constructs the research-scan prompt per "Prompt
   Construction" below and writes it to a per-dispatch temporary file
   (UTF-8), then passes that file to the runner. The prompt contains
   user-controlled, genericized material (topic, sub-questions, scope),
   so it MUST be passed via `--prompt-file <path>` per
   `companions/contract.md` § 2.2 — never as a positional argument and
   never inlined into a shell command. The companion reads the file
   directly; the prompt never crosses shell parsing, process argv, or
   `ps aux`.
5. The runner invokes the companion in **JSON envelope mode**:

   ```
   <peer-companion> task --prompt-file <path> --output-format json [--cwd <wd>]
   ```

   per `companions/contract.md` § 4.2. The caller SHOULD background the
   call so the local host's own research can proceed in parallel. The
   runner MUST NOT pass companion-internal flags (no `--background`, no
   timeout knobs); those are out of contract scope per
   `companions/contract.md` § 6.2 and § 6.4.
6. The local host proceeds immediately to per-sub-question WebSearch /
   WebFetch.

### Step 2: Collect — before profile synthesis

1. Wait for the background dispatch notification — do NOT poll, sleep,
   or proactively check status.
2. Read the JSON envelope from the companion's stdout. The envelope keys
   are pinned by `companions/contract.md` § 4.2:
   `{status, peer_host, peer_model, stdout, exit_code, [error, metadata]}`.
3. Classify by `status`:
   - `success` → proceed to peer-claim parsing.
   - `peer_error` (`error.kind: peer_run_error`) → treat as peer
     malformed-or-empty (see "Failure Handling").
   - `companion_error` with `error.kind ∈ {peer_cli_not_found,
     peer_unauthenticated, peer_invocation_error}` → peer infrastructure
     unavailable; degrade to local-only.
   - `companion_error` with `error.kind: companion_misuse` → adapter
     bug; surface as a runtime error (NOT a degradation case — it
     indicates the dispatcher constructed an invalid invocation).
4. The peer's `stdout` is the structured answer to the research-scan
   prompt: claims and sources for each sub-question. Parse against the
   Normalized Claim Shape below.
5. If the peer failed in any failure-mode, record the failure internally
   and proceed to Synthesize with local-only findings. Mention
   degradation in the user-facing completion summary AFTER the brief is
   saved — never as a finding label inside the brief artifact.

### Step 3: Synthesize — during business-brief profile synthesis

1. Normalize each peer finding into the intermediate Claim Shape below.
2. Reconcile local findings with peer findings via the four-category
   taxonomy below.
3. Apply Citation Remapping: the peer's labels are NEVER copied into the
   final brief. Each peer source must be locally verified before
   becoming a numeric `[N]` entry in the Sources section.
4. Apply Source Union for AGREED-with-different-sources cases.
5. Resolve PEER-ONLY factual claims via the rules below.
6. Hand the merged content back to the business-brief profile's audit and
   save flow for sub-question organization, citation numbering (capture
   order preserved), tier/freshness/jurisdiction tagging, and confidence
   rating.

---

## Prompt Construction

The research-scan prompt is composed of XML blocks. Required blocks:

- `<task>` — genericized topic, sub-questions, scope statement, jurisdiction(s)
- `<structured_output_contract>` — output shape (claim → conclusion → sources)
- `<grounding_rules>` — every claim grounded in a verifiable source
- `<research_mode>` — separate observed facts from inferences
- `<citation_contract>` — what the peer must include with each source
- `<privacy_contract>` — what the peer must NOT include in its response

Template:

```xml
<task>
Independently research the following business topic. Answer each
sub-question with cited evidence. Do not see the local host's findings —
produce a fresh analysis from authoritative sources where available.

Topic: {genericized topic}
Jurisdiction(s): {market geographies in scope, or "unspecified"}
Scope: {scope statement}
Sub-questions:
1. {sub-question 1}
2. {sub-question 2}
{...}
</task>

<structured_output_contract>
For each sub-question, return:
1. Sub-question (verbatim)
2. Claim (one-sentence answer)
3. Conclusion (longer synthesis paragraph)
4. Sources (list of {url, title, tier, access-date, as-of, jurisdiction, access-note})
   - tier: official-stats | research-institutional | market-intelligence | primary-field | secondary-press
   - as-of: the date the underlying data describes (when time-bound)
   - jurisdiction: the geography the data applies to (when jurisdiction-bound)
   - access-note: public | paywalled | summary-of-paid-report | vendor-claim | estimate
5. Confidence (HIGH | MEDIUM | LOW)
6. Caveats (freshness, jurisdiction limits, alternative interpretations)
</structured_output_contract>

<citation_contract>
- Each substantive claim is backed by at least one source URL.
- Source URLs must be retrievable (no paywalled-only or invented URLs);
  when a figure is only available behind a paywall or as a vendor claim,
  mark it via access-note rather than presenting it as verified.
- Tier classification matches the four URL-bearing business tiers
  (official-stats / research-institutional / market-intelligence /
  secondary-press). Do NOT contribute `primary-field` evidence
  (interviews, surveys, observation, pilot data): you have no first-party
  field access. Reason only from retrievable public sources, plus any
  anonymized aggregates the task block already supplies. A fabricated
  "interview finding" will be discarded.
- Market / pricing / regulatory figures carry an as-of date and a
  jurisdiction tag.
- Access date in ISO YYYY-MM-DD.
- Do NOT use peer-internal numeric citation labels in the response —
  identify each source by URL.
</citation_contract>

<grounding_rules>
Every claim references a specific source URL. Inferences (synthesis
beyond cited material, including cross-jurisdiction or cross-segment
extrapolation) are explicitly labeled "INFERENCE:". Vendor/marketing
claims ("market leader", "fastest-growing", "TAM of $X") require
independent corroboration or are marked as vendor-claim/estimate.
</grounding_rules>

<research_mode>
Separate observed facts from inferences.
Prefer breadth across sub-questions before depth on any one.
Prefer official-stats and research-institutional tiers for hard numbers.
</research_mode>

<privacy_contract>
The topic and sub-questions have been pre-genericized for proprietary
content. Do not fabricate identifiers, company names, customer names, or
figures beyond what is stated. Do not echo back any internal identifier
the topic may still reference. Do not attempt to de-anonymize a
genericized concept to a specific named company or product.
</privacy_contract>
```

Model and effort are NOT passed via flags — the user's peer-host
configuration is the single source of truth. (`companions/contract.md`
§ 2.2 makes `--model` / `--effort` optional; founder's always-max policy
declines to override at the protocol layer.)

---

## Independence Rule

The peer must analyze independently. The peer prompt MUST NOT include:

- The local host's in-progress findings, synthesis drafts, or citation list.
- The local host's confidence ratings or judgments about sources.
- The local host's interpretation of which sub-questions are easy or hard.

The Independence Rule is explicitly **bidirectional**: when the local
host is Claude, Claude does not leak its findings into the
`codex-companion` prompt; when the local host is Codex, Codex does not
leak its findings into the `claude-companion` prompt. Both models receive
the same raw context: genericized topic, sub-questions, scope,
jurisdiction. Each model conducts its own search and citation capture.
The research-scan ensemble is **true parallel research**, not gap
analysis. There is no verify-style exception in this protocol.

---

## Normalized Claim Shape

The intermediate shape applied to BOTH local and peer findings before
synthesis:

```
{
  sub_question: <verbatim text>,
  claim: <one-sentence answer>,
  conclusion: <longer synthesis>,
  sources: [
    { url: <canonical url>,
      title: <or hostname/path fallback>,
      tier: official-stats | research-institutional | market-intelligence | primary-field | secondary-press,
      access_date: <ISO YYYY-MM-DD>,
      as_of: <date the data describes, or null>,
      jurisdiction: <geography, or null>,
      access_note: public | paywalled | summary-of-paid-report | vendor-claim | estimate
    },
    ...
  ],
  confidence: HIGH | MEDIUM | LOW,
  caveats: <freshness, jurisdiction, alternatives, limits>
}
```

This shape is internal — it is not written into the brief artifact. The
brief uses the structure defined in `business-brief-spec.md`. Synthesis
maps normalized claims into the brief's Findings and Sources sections.

---

## Synthesis Categories

Every claim from either model classifies into one of four categories
during reconciliation:

| Category     | Condition                                              |
|--------------|--------------------------------------------------------|
| AGREED       | Both models reached the same conclusion                |
| LOCAL-ONLY   | The local host found it, the peer did not              |
| PEER-ONLY    | The peer found it, the local host did not              |
| CONFLICT     | Models reached opposing conclusions                    |

`LOCAL-ONLY` / `PEER-ONLY` are host-neutral — they describe the discovery
side relative to the invoked profile, regardless of which host happens to
be local. The same protocol works in both directions.

### AGREED handling

- Same sources: present once with the existing citations.
- Different sources, same conclusion: AGREED + **Source Union**
  (verified, URL-deduplicated). Each peer source goes through Citation
  Remapping before joining the union.
- Same conclusion, different confidence: take the higher confidence level
  only when its source-tier coverage is at least as strong as the
  lower-confidence side. Otherwise keep the lower confidence and record
  the divergence in Open Questions.

### LOCAL-ONLY handling

Present normally with the local host's citations. **No
source-of-discovery label appears in the brief artifact** — the brief
never carries `[Local]` / `[Peer]` / `[Both]` markers (per
`business-brief-spec.md` "Ensemble Label Policy"). Workflow phase notes
elsewhere may carry these labels for orchestration transparency, but the
saved brief artifact strips them.

### PEER-ONLY handling

The brief's audit checklist requires every substantive claim to have
either a `[N]` citation OR an allowed sentinel. PEER-ONLY claims must
take ONE of these paths:

- **Path A — Verify and cite**: The local host fetches the peer-provided
  source via WebFetch (or its host-equivalent), confirms the claim, tags
  it with tier / as-of / jurisdiction / access-note, and adds a numeric
  `[N]` citation in research capture order. The claim becomes a normal
  cited finding, indistinguishable from locally-discovered findings.
- **Path B — Open Question**: Move the claim into the brief's "Open
  Questions / Gaps" section as an unresolved evidence pointer. The Open
  Questions entry mentions the topic of the gap but does NOT cite the
  unverified source — bare-URL pointers do not pass the audit.

Path C — using `[uncited inference]` — is **forbidden** for factual
external claims. The `[uncited inference]` sentinel is reserved for the
model's own interpretation/synthesis (including extrapolation). A factual
claim attributed to an external source cannot be inference; it must be
verified or deferred.

### CONFLICT handling

Apply the Conflict Handling rule from `business-brief-spec.md`: present
both interpretations with their citations, tier-asymmetric resolution,
freshness/jurisdiction participating in tier asymmetry. Do not pick a
winner unless one source is significantly higher tier (or fresher /
on-jurisdiction for a fast-moving claim). The wording in
`business-brief-spec.md` is canonical when the two rules diverge.

---

## Citation Remapping

The peer's response uses peer-internal labels (none, prose, or its own
numbering scheme). These are NOT copied into the final brief. Mapping
rule:

1. For each peer source URL, canonicalize: strip tracking parameters and
   trailing-slash variations.
2. Compare against the local host's already-captured Sources by canonical
   URL.
3. If match: the source is already in the brief; the peer finding's
   citation is the existing `[N]`.
4. If no match (new source from the peer), apply Path A or Path B from
   "PEER-ONLY handling" above. Path A appends a new entry to Sources in
   research capture order — the next available `[N]`. Path B does not
   modify Sources.

The brief's Sources section remains single-numbered, capture-order
preserving, and URL-deduplicated per `business-brief-spec.md`. The peer
contributes to that ordering only via Path A.

---

## Privacy

The business-brief profile's privacy gate covers external ensemble
dispatch in addition to web search. Specifically:

- The topic AND sub-questions transmitted in the peer prompt are treated
  as external transmission. Apply the same genericization rules as
  WebSearch — no proprietary venture concept, customer/interview
  identities, unpublished product or pricing names, internal financials,
  or pasted internal documents.
- The `<privacy_contract>` block in the prompt instructs the peer to
  refrain from fabricating or echoing proprietary identifiers and from
  de-anonymizing a genericized concept.
- If the genericization substitution is generic (e.g., "AI scheduling
  software for healthcare providers"), pass the substituted form to the
  peer too — never the original pre-genericization value.

The privacy gate is **bidirectional** — the same discipline applies
whether the local host is Claude (sending to Codex) or Codex (sending to
Claude). The pre-genericization value MUST never leave the local host.

When the user declines genericization or aborts the session, do NOT
dispatch to the peer.

---

## Failure Handling

Failure modes map to the JSON envelope `error.kind` values defined in
`companions/contract.md` § 5.3, plus per-claim malformed-output cases
that surface only after parsing the peer's content.

### Peer host CLI unavailable, not installed, or unauthenticated

- Detect: `error.kind ∈ {peer_cli_not_found, peer_unauthenticated,
  peer_invocation_error}`, OR `peer-runner.mjs run` returns no companion
  path (`peer_cli_not_found` equivalent at the discovery layer).
- Action: Skip dispatch silently. Proceed with local-only research.
- Surface: Mention in the user-facing completion summary that the
  ensemble was unavailable. Do NOT label findings inside the brief.

### Peer timeout or runtime error

- Detect: `status: peer_error` with `error.kind: peer_run_error`, OR the
  background dispatch exits unmappably (treated as
  `peer_invocation_error`).
- Action: Record the failure mode internally; proceed local-only.
- Surface: Same as above.

### Peer returns empty output

- Detect: Envelope `status: success` but `stdout` parses to no claims,
  only structural shell, or is missing the per-sub-question response
  blocks.
- Action: Treat as if the peer was unavailable. Proceed local-only.
- Surface: Same as above.

### Peer returns malformed partial output

- Detect: `stdout` is structurally valid but missing required fields for
  some claims (e.g., tier omitted, claim without conclusion, source-URL
  field empty).
- Action: Parse only the claims that pass structural validation (claim +
  conclusion + at least one retrievable source URL). Discard claims with
  unverifiable or empty source URLs. Continue with the salvageable subset.
- Surface: Mention in the completion summary that ensemble coverage was
  partial.

### Peer returns PEER-ONLY claim with no source URL

- Treat as malformed at the per-claim level (no source URL means nothing
  to verify).
- Discard the claim. Do NOT add it to Open Questions — there is nothing
  to follow up on.

### Graceful degradation principle

The brief is always assembled and saved on the local-only path. Ensemble
failure NEVER blocks save. The completion summary states the degradation;
the brief itself shows no ensemble-specific labels or markers — readers
of the brief should not be able to tell whether the ensemble ran at all.

---

## State and Recovery

The business-brief profile writes phase notes through founder's
persistent workflow `.md` via `state.mjs`:

- The command-mode flow appends phase notes through `state.mjs append` at
  each protocol step (Launch, Collect, Synthesize). The notes preserve a
  body-level audit trail of which ensemble was launched at what time and
  what its synthesis verdict was, in human-readable form.
- The brief artifact itself (the saved `business_brief.md`) remains the
  durable artifact; even if the workflow `.md` is archived later, the
  brief is preserved at its `<root>/YYYY-MM-DD_<topic-slug>/` location.

In-flight peer dispatches do NOT survive session compaction. The
schema-1.x `pending_ensemble` field records that a dispatch began
(`run_id` + `started_at`), but the background task itself is not
recoverable across sessions — the OS process is gone. If a peer dispatch
is in flight when the session compacts, the recovered session sees both
the in-flight phase note (`### Ensemble launched: research-scan at
<iso-utc>`) and the `pending_ensemble[]` entry with the matching
`run_id`; it cannot collect the original background task. The next
session must re-dispatch (the helper is idempotent on `run_id` so
duplicate entries do not accumulate).

Workflow re-entry uses founder's own continuity — `scripts/state.mjs`
restores the workflow `.md`'s tasks frontmatter and current_phase per
ADR-0011 §5; the business-brief profile inherits that without
profile-specific wiring.

---

## Boundary with decision-bound flows

The business-brief profile is **topic-bound** and produces a durable
cited brief. Decision-bound flows (option comparison, recommendation) are
NOT within this profile's scope; they belong to:

- `founder:decide` — for option comparison and direction selection.
- `founder:critique` — for evaluating an existing artifact.
- `founder:frame` — for turning evidence into a problem model.

A user gathering market/regulatory/competitive evidence reaches for
`founder:investigate --profile=business-brief`; a user choosing between
business directions reaches for `founder:decide`. The business-brief
profile may be invoked first to produce a brief that `founder:decide`
then consumes as additional input — but the two are distinct verbs by
design (per ADR-0010 §2 6-verb model).

---

## Related

- `../SKILL.md` — founder:investigate skill body; the business-brief
  profile branches call into this protocol from command-invoked mode.
- `business-brief-spec.md` — canonical brief structure, 5-tier taxonomy,
  freshness/jurisdiction rules, paywalled treatment, privacy gate,
  citation conventions, audit checklist.
- `output-file-rules.md` — output-file conventions; the
  existing-directory check that gates ensemble dispatch lives there.
- `../../_shared/references/ensemble-protocol.md` — founder's standard
  ensemble protocol (all nine business-anchored point types). Lands in
  ADR-0036 PR5; will cross-reference this file for the research-scan point.
- `../../../scripts/peer-runner.mjs` — founder's managed peer runner; the
  mechanics that resolve and invoke the peer companion, write the ledger,
  and record `pending_ensemble` for command-managed ensembles.
- `../../../scripts/dispatch-peer.mjs` — founder's blocking compatibility
  dispatcher for legacy/raw callers.
- `companions/contract.md` v0.1.1 — wire-spec contract for both companion
  bridges (`claude-companion`, `codex-companion`).
- `docs/adr/0008-companion-distribution-model.md` — companion
  distribution model (cache-glob discovery + env override).
- `docs/adr/0010-plugin-boundary-policy.md` — 4-layer composition,
  naming, §5 no-import.
- `docs/adr/0036-founder-persona-business-planning.md` — the founder
  persona decision; SD4 specifies this business source taxonomy + privacy
  gate.
