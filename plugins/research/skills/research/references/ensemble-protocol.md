# Research Ensemble Protocol

Defines how the local host and a peer host operate as a dual-model
ensemble for the **research-scan** ensemble point — the research-domain
analog of the text ensemble points used by other agentic-plugins
skills. Activated inside the research skill's command-invoked mode to
cross-validate sub-question findings against an independent model on
the peer host.

The user never invokes the peer host directly. The skill orchestrates
dispatch, collection, and synthesis transparently through
`companions/contract.md` v0.1.0 (Claude → Codex via `codex-companion`,
Codex → Claude via `claude-companion`). When the peer host is not
installed or returns no usable output, the ensemble degrades silently
to local-only.

This document is the **bidirectional contract** for research-scan.
Mechanics — how to discover the companion script, how to invoke it,
how to consume its JSON envelope — live in each host's adapter
(`adapters/<host>/scripts/discover-companion.mjs` plus the SKILL.md
command-invoked-mode prose). This protocol describes only the
wire-level contract: what to send, what to expect back, how to
synthesize.

---

## When This Protocol Applies

Activates inside the research skill's command-invoked mode (Step 1
end through Step 3 entry) when invoked as:

- Claude: `/research:research <topic>` (slash command)
- Codex: `$research <topic>` (skill mention)

Does NOT apply to:

- Auto-activated research outside the command-invoked mode.
- Inline cross-references from other plugins or commands.
- Binary confirmations or progress updates within the same session.

---

## Affinity

For research v1 the ensemble is **always-on** for command-invoked
research. The research domain's quality dimensions (topic depth,
source-tier requirement, controversy, freshness) do not map cleanly
onto the file/layer/risk-based affinity tiers used by code workflows.
A future version may introduce graduated affinity; v1 keeps the
surface simple and relies on graceful degradation when the cost would
be unjustified (e.g., the peer host CLI is not installed).

---

## Execution Pattern

Three steps per research session: **Launch**, **Collect**, **Synthesize**.

### Step 1: Launch — after sub-question confirmation + scope

Pre-conditions before dispatch:

1. The privacy gate has passed for the topic AND the confirmed
   sub-questions. The gate covers BOTH web search AND external
   ensemble dispatch — see "Privacy" below.
2. The existing-directory check (per
   `skills/research/references/output-file-rules.md`) has completed
   and the user did NOT choose abort. Aborting before dispatch
   prevents wasted peer runs on a session the user will discard.

Dispatch (mechanics owned by the adapter; this protocol pins shape
only):

3. The adapter resolves the peer-companion script path per
   `adapters/<host>/scripts/discover-companion.mjs` (cache-glob with
   `AGENTIC_COMPANIONS_ROOT` env override, per ADR-0008). If
   discovery fails, the ensemble degrades to local-only per "Failure
   Handling" below.
4. The adapter constructs the research-scan prompt per "Prompt
   Construction" below and writes it to a per-dispatch temporary file
   (UTF-8). The prompt contains user-controlled material (topic,
   sub-questions, scope), so it MUST be passed via
   `--prompt-file <path>` per `companions/contract.md` § 2.2 — never
   as a positional argument and never inlined into a shell command.
   The companion reads the file directly; the prompt never crosses
   shell parsing, process argv, or `ps aux`.
5. The adapter invokes the companion in **JSON envelope mode**:

   ```
   <peer-companion> task --prompt-file <path> --output-format json [--cwd <wd>]
   ```

   per `companions/contract.md` § 4.2. The adapter SHOULD background
   the call so the local host's own research can proceed in parallel.
   The adapter MUST NOT pass companion-internal flags (no
   `--background`, no timeout knobs); those are out of contract scope
   per `companions/contract.md` § 6.2 and § 6.4.
6. The local host proceeds immediately to Step 2 of the research
   SKILL (per-sub-question WebSearch / WebFetch).

### Step 2: Collect — before research SKILL Step 3 synthesis

1. Wait for the background dispatch notification — do NOT poll, sleep,
   or proactively check status.
2. Read the JSON envelope from the companion's stdout. The envelope
   keys are pinned by `companions/contract.md` § 4.2:
   `{status, peer_host, peer_model, stdout, exit_code, [error, metadata]}`.
3. Classify by `status`:
   - `success` → proceed to peer-claim parsing.
   - `peer_error` (`error.kind: peer_run_error`) → treat as peer
     malformed-or-empty (see "Failure Handling").
   - `companion_error` with `error.kind ∈ {peer_cli_not_found,
     peer_unauthenticated, peer_invocation_error}` → peer infrastructure
     unavailable; degrade to local-only.
   - `companion_error` with `error.kind: companion_misuse` → adapter
     bug; surface as a runtime error (this is NOT a degradation case —
     it indicates the adapter constructed an invalid invocation).
4. The peer's `stdout` is the structured answer to the research-scan
   prompt: claims and sources for each sub-question. Parse against
   the Normalized Claim Shape below.
5. If the peer failed in any failure-mode, record the failure
   internally and proceed to Synthesize with local-only findings.
   Mention degradation in the user-facing completion summary AFTER
   the brief is saved — never as a finding label inside the brief
   artifact.

### Step 3: Synthesize — during research SKILL Step 3

1. Normalize each peer finding into the intermediate Claim Shape
   defined below.
2. Reconcile local findings with peer findings via the four-category
   taxonomy below.
3. Apply Citation Remapping: the peer's labels are NEVER copied into
   the final brief. Each peer source must be locally verified before
   becoming a numeric `[N]` entry in the Sources section.
4. Apply Source Union for AGREED-with-different-sources cases.
5. Resolve PEER-ONLY factual claims via the rules below.
6. Hand the merged content back to research SKILL Step 3 for
   sub-question organization, citation numbering (capture order
   preserved), and confidence rating.

---

## Prompt Construction

The research-scan prompt is composed of XML blocks. Required blocks:

- `<task>` — sanitized topic, sub-questions, scope statement
- `<structured_output_contract>` — output shape (claim → conclusion → sources)
- `<grounding_rules>` — every claim grounded in a verifiable source
- `<research_mode>` — separate observed facts from inferences
- `<citation_contract>` — what the peer must include with each source
- `<privacy_contract>` — what the peer must NOT include in its response

Template:

```xml
<task>
Independently research the following topic. Answer each sub-question
with cited evidence. Do not see the local host's findings — produce a
fresh analysis from primary sources where available.

Topic: {sanitized topic}
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
4. Sources (list of {url, title, source-type, access-date})
   - source-type: official-docs | standards | academic | secondary
5. Confidence (HIGH | MEDIUM | LOW)
6. Caveats (limits, freshness concerns, alternative interpretations)
</structured_output_contract>

<citation_contract>
- Each substantive claim is backed by at least one source URL.
- Source URLs must be retrievable (no paywalled-only or invented URLs).
- Source-type classification matches the four-tier taxonomy in
  the research brief spec (official-docs / standards / academic /
  secondary).
- Access date in ISO YYYY-MM-DD.
- Do NOT use peer-internal numeric citation labels in the response —
  identify each source by URL.
</citation_contract>

<grounding_rules>
Every claim references a specific source URL. Inferences (synthesis
beyond cited material) are explicitly labeled "INFERENCE:".
Marketing claims ("best", "fastest", "most popular") require benchmark
or consensus citations.
</grounding_rules>

<research_mode>
Separate observed facts from inferences.
Prefer breadth across sub-questions before depth on any one.
</research_mode>

<privacy_contract>
The topic and sub-questions have been pre-sanitized for proprietary
content. Do not fabricate identifiers, paths, or names beyond what is
stated. Do not echo back any internal identifier the topic may still
reference.
</privacy_contract>
```

Model and effort are NOT passed via flags — the user's peer-host
configuration is the single source of truth. (`companions/contract.md`
§ 2.2 makes `--model` / `--effort` optional; this protocol does not
set them.)

---

## Independence Rule

The peer must analyze independently. The peer prompt MUST NOT include:

- The local host's in-progress findings, synthesis drafts, or citation list.
- The local host's confidence ratings or judgments about sources.
- The local host's interpretation of which sub-questions are easy or hard.

The Independence Rule is explicitly **bidirectional**: when the local
host is Claude, Claude does not leak its findings into the
`codex-companion` prompt; when the local host is Codex, Codex does
not leak its findings into the `claude-companion` prompt. Both models
receive the same raw context: topic, sub-questions, scope. Each model
conducts its own search and citation capture. The research-scan
ensemble is **true parallel research**, not gap analysis. There is no
verify-style exception in this protocol.

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
      source_type: official-docs | standards | academic | secondary,
      access_date: <ISO YYYY-MM-DD>
    },
    ...
  ],
  confidence: HIGH | MEDIUM | LOW,
  caveats: <freshness, alternatives, limits>
}
```

This shape is internal — it is not written into the brief artifact.
The brief uses the structure defined in
`skills/research/references/research-brief-spec.md`. Synthesis maps
normalized claims into the brief's Findings and Sources sections.

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

`LOCAL-ONLY` / `PEER-ONLY` are host-neutral — they describe the
discovery side relative to the invoked skill, regardless of which
host happens to be local. The same protocol works in both directions.

### AGREED handling

- Same sources: present once with the existing citations.
- Different sources, same conclusion: AGREED + **Source Union**
  (verified, URL-deduplicated). Each peer source goes through
  Citation Remapping before joining the union.
- Same conclusion, different confidence: take the higher confidence
  level only when its source-tier coverage is at least as strong as
  the lower-confidence side. Otherwise keep the lower confidence and
  record the divergence in Open Questions.

### LOCAL-ONLY handling

Present normally with the local host's citations. No special label
appears in the brief — the brief never carries source-of-discovery
labels (per `skills/research/references/research-brief-spec.md`
"Ensemble Label Policy").

### PEER-ONLY handling

The brief's audit checklist requires every substantive claim to have
either a `[N]` citation OR an allowed sentinel (per
`skills/research/references/research-brief-spec.md`). PEER-ONLY
claims must take ONE of these paths:

- **Path A — Verify and cite**: The local host fetches the
  peer-provided source via WebFetch (or its host-equivalent),
  confirms the claim, and adds a numeric `[N]` citation in research
  capture order. The claim becomes a normal cited finding,
  indistinguishable from locally-discovered findings in the final
  brief.
- **Path B — Open Question**: Move the claim into the brief's
  "Open Questions / Gaps" section as an unresolved evidence pointer.
  The Open Questions entry mentions the topic of the gap but does NOT
  cite the unverified source — bare-URL pointers do not pass the
  audit.

Path C — using `[uncited inference]` — is **forbidden** for factual
external claims. The `[uncited inference]` sentinel is reserved for
the model's own interpretation/synthesis. A factual claim attributed
to an external source cannot be inference; it must be verified or
deferred.

### CONFLICT handling

Apply the Conflict Handling rule from the research SKILL Step 3:
present both interpretations with their citations. Do not pick a
winner unless one source is significantly higher tier. The wording in
`skills/research/references/research-brief-spec.md` is canonical when
the two rules diverge.

---

## Citation Remapping

The peer's response uses peer-internal labels (none, prose, or its
own numbering scheme). These are NOT copied into the final brief.
Mapping rule:

1. For each peer source URL, canonicalize: strip tracking parameters
   and trailing-slash variations.
2. Compare against the local host's already-captured Sources by
   canonical URL.
3. If match: the source is already in the brief; the peer finding's
   citation is the existing `[N]`.
4. If no match (new source from the peer), apply Path A or Path B
   from "PEER-ONLY handling" above. Path A appends a new entry to
   Sources in research capture order — the next available `[N]`.
   Path B does not modify Sources.

The brief's Sources section remains single-numbered, capture-order
preserving, and URL-deduplicated per
`skills/research/references/research-brief-spec.md`. The peer
contributes to that ordering only via Path A.

---

## Privacy

The research SKILL Step 1.1 privacy gate covers external ensemble
dispatch in addition to web search. Specifically:

- The topic AND sub-questions transmitted in the peer prompt are
  treated as external transmission. Apply the same redaction rules
  as WebSearch — no proprietary identifiers, paths, customer names,
  unpublished product names, or pasted internal documents.
- The `<privacy_contract>` block in the prompt instructs the peer to
  refrain from fabricating or echoing proprietary identifiers.
- If the user's redaction substitution is generic (e.g., "service X"),
  pass the substituted form to the peer too — never the original
  pre-redaction value.

The privacy gate is **bidirectional** — the same redaction discipline
applies whether the local host is Claude (sending to Codex) or Codex
(sending to Claude). The pre-redaction value MUST never leave the
local host.

When the user declines redaction or aborts the session, do NOT
dispatch to the peer.

---

## Failure Handling

Failure modes map to the JSON envelope `error.kind` values defined in
`companions/contract.md` § 5.3, plus per-claim malformed-output cases
that surface only after parsing the peer's content.

### Peer host CLI unavailable, not installed, or unauthenticated

- Detect: `error.kind ∈ {peer_cli_not_found, peer_unauthenticated,
  peer_invocation_error}` per `companions/contract.md` § 5.3, OR the
  adapter's discovery script returns no companion path
  (`peer_cli_not_found` equivalent at the discovery layer).
- Action: Skip dispatch silently. Proceed with local-only research.
- Surface: Mention in the user-facing completion summary that the
  ensemble was unavailable. Do NOT label findings inside the brief.

### Peer timeout or runtime error

- Detect: `status: peer_error` with `error.kind: peer_run_error`, OR
  the background dispatch exits in a way the adapter cannot map to
  any envelope `error.kind` (treated as `peer_invocation_error`).
- Action: Record the failure mode internally; proceed with local-only
  research.
- Surface: Same as above.

### Peer returns empty output

- Detect: Envelope `status: success` but `stdout` parses to no claims,
  only structural shell, or is missing the per-sub-question response
  blocks.
- Action: Treat as if the peer was unavailable. Proceed with
  local-only research.
- Surface: Same as above.

### Peer returns malformed partial output

- Detect: `stdout` is structurally valid but missing required fields
  for some claims (e.g., source-type omitted, claim without
  conclusion, source-URL field empty).
- Action: Parse only the claims that pass structural validation
  (claim + conclusion + at least one retrievable source URL).
  Discard claims with unverifiable or empty source URLs. Continue
  with the salvageable subset for synthesis.
- Surface: Mention in the completion summary that ensemble coverage
  was partial.

### Peer returns PEER-ONLY claim with no source URL

- Treat as malformed at the per-claim level (no source URL means
  nothing to verify).
- Discard the claim. Do NOT add it to Open Questions — there is
  nothing to follow up on.

### Graceful degradation principle

The brief is always assembled and saved on the local-only path.
Ensemble failure NEVER blocks save. The completion summary states
the degradation; the brief itself shows no ensemble-specific labels
or markers — readers of the brief should not be able to tell whether
the ensemble ran at all.

---

## State and Recovery

The research skill has no workflow file analogous to omcc-dev's
`/start` / `/fix` / `/audit` state. The research-scan ensemble is
therefore **in-session only**:

- If the session compacts or terminates while a peer dispatch is in
  flight, that dispatch becomes uncollectable. The next research
  invocation does NOT recover it — the user re-runs the topic.
- This is an explicit design gap for v1. A future version with
  workflow state may add recovery; v1 trades recovery for plugin
  simplicity.

---

## Boundary with decision-bound flows

Research is **topic-bound** and produces a durable cited brief.
Decision-bound flows (option comparison, recommendation) are NOT
within research's scope; they belong to skills designed for that
shape, which use a different ensemble template and synthesize into a
different artifact contract. Researchers gathering evidence reach for
research; users choosing between options reach for the appropriate
decision-bound skill.

The shared bidirectional ensemble surface
(`companions/contract.md` v0.1.0) does not blur this boundary — each
skill owns its prompt template and artifact contract.

---

## Related

- `skills/research/SKILL.md` — research skill body; calls into this
  protocol from its command-invoked mode.
- `skills/research/references/research-brief-spec.md` — canonical
  brief structure, citation conventions, audit checklist.
- `skills/research/references/output-file-rules.md` — output-file
  conventions; the existing-directory check that gates ensemble
  dispatch lives here.
- `adapters/claude/scripts/discover-companion.mjs` and
  `adapters/codex/scripts/discover-companion.mjs` — host-side
  mechanics that resolve and invoke the peer companion. This
  protocol describes intent only; mechanics live there.
- `companions/contract.md` v0.1.0 — wire-spec contract for both
  companion bridges (`claude-companion`, `codex-companion`).
- `docs/adr/0008-companion-distribution-model.md` — companion
  distribution model (cache-glob discovery + env override) that the
  discovery scripts implement.
