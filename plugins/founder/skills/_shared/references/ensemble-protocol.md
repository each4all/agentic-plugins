# Ensemble Protocol (founder persona)

Defines how the local host and a peer host operate as a dual-model
**bidirectional** ensemble within the founder plugin. Either host can be
the **orchestrator** (the host where the user is currently invoking the
skill); the other is the **peer**. The orchestrator drives the workflow,
dispatches the peer for independent parallel analysis, and synthesizes
both perspectives into a unified business result.

**Plugin boundary note**: this is founder's **own copy** of the ensemble
protocol (lives at `plugins/founder/skills/_shared/references/`). Per
ADR-0010 §5 cross-plugin imports are forbidden — founder ships its own
copy rather than importing engineer's (ADR-0029 §Neutral copy/adapt
rule). The **mechanics** (Launch / Collect / Synthesize, the
AGREED / LOCAL-ONLY / PEER-ONLY / CONFLICT vocabulary, graceful
degradation) are the shared shape; the **point templates** below are
re-anchored from software concerns (files, layers, defects) to business
concerns (markets, unit-economics, regulation, competition) per
ADR-0036 SD6 / F7. If the protocol proves universal across L3 personas,
an L1/L2 extraction may be considered through a fresh ADR; this file
does NOT serve cross-persona imports as-is.

The nine point types below are the business analogue of the engineer
ensemble point set. The **research-scan** point has its full
bidirectional contract in
`../../investigate/references/business-brief-ensemble.md` (landed at
ADR-0036 PR3); this file cross-references it rather than duplicating the
citation-remapping / Path-A / Path-B machinery.

---

## Always-max policy

Every phase boundary in `/founder:*` commands automatically dispatches
the peer ensemble. **There is no `LOW` skip.** founder's user value is
maximum-quality decision support; the peer call is paid at every phase
boundary regardless of the `Ensemble Affinity` rating recorded in the
Business Task Profile (`./orchestration.md` Step 1).

The peer call uses the host's configured model with maximum
effort/depth. Skills do **not** pass `--model` or `--effort` flags —
each host's config file (`~/.codex/config.toml`,
`~/.claude/settings.json`, etc.) is the single source of truth.

`Ensemble Affinity` (LOW / MEDIUM / HIGH) is retained as a Task Profile
axis (records context about the task) but does **not** gate dispatch.

---

## Bidirectional invocation pattern

Direction is symmetric:

| Orchestrator | Peer        | Peer invocation                                                |
|--------------|-------------|----------------------------------------------------------------|
| Claude Code  | Codex CLI   | `codex-companion` (resolved via `companions` plugin discovery) |
| Codex CLI    | Claude Code | `claude-companion` (resolved via `companions` plugin discovery)|

Both companion CLIs ship in the agentic-plugins `companions` plugin and
implement `companions/contract.md` v0.1.1. The contract exposes a single
subcommand `task --prompt-file <path>` accepting an XML prompt. founder
expresses every ensemble point type as a `task` invocation with a
type-specific prompt template; review-style ensembles (review,
refine-verify, adversarial-scan) embed the review semantics in the
prompt itself rather than relying on separate subcommands.

The orchestrator is the currently-invoking host; the peer is the other
host. Skills never hard-code one side or the other — they refer to
*orchestrator* and *peer*. Discovery + dispatch mechanics live in
`../../../scripts/peer-runner.mjs` (the managed runner for
command-runbook ensembles), with `../../../scripts/dispatch-peer.mjs`
retained as the blocking compatibility surface. On discovery failure the
dispatch is skipped silently per *Failure Handling* below.

---

## When This Protocol Applies

Activates automatically at every command-defined phase boundary in
`/founder:*` commands. Each command file specifies which phase invokes
which ensemble point type (see *Ensemble Point Types* below).

- Claude: `/founder:<verb> …` (slash command)
- Codex: `$founder:<verb> …` (skill mention; per ADR-0036 SD2
  cognitive-runbook parity, full slash-command parity is deferred to
  ADR-0013 reserved)

Does NOT apply to:
- Skills auto-activated outside any `/founder:*` command (auto-activated
  mode runs without ensemble dispatch — the lightweight in-context path).
- Binary confirmations or progress updates within the same session.
- Internal orchestration decisions.

---

## Execution Pattern

Every ensemble point follows three steps: **Launch**, **Collect**,
**Synthesize**.

### Step 1: Launch

1. Determine the ensemble point type (see *Ensemble Point Types* below).
2. **Pass the privacy gate** (see *Privacy* below) for the topic AND
   everything that will travel in the peer prompt. Proprietary venture
   concepts, interview/customer data, and unpublished business material
   pass an explicit gate before BOTH web search AND peer-host dispatch.
   Genericize before constructing the prompt.
3. Resolve the peer companion via the companion-cache discovery
   (`AGENTIC_COMPANIONS_ROOT` env override honored, per ADR-0008). If
   discovery fails, the ensemble degrades to local-only.
4. Construct the peer prompt per the type-specific template (see *Prompt
   Construction Rules*). Write it to a per-dispatch UTF-8 tempfile and
   pass it via `--prompt-file <path>` per `companions/contract.md` §2.2 —
   never as a positional argument and never inlined into a shell command,
   so the genericized prompt never crosses shell parsing, process argv,
   or `ps aux`.
5. Invoke the companion in **JSON envelope mode** through
   `../../../scripts/peer-runner.mjs run`, which records the matching
   `pending_ensemble` row and writes raw stdout/stderr plus the parsed
   envelope under the hidden peer-run ledger. The orchestrator SHOULD
   background the call (Bash `run_in_background` on Claude; the `task`
   subcommand on Codex) so its own analysis proceeds in parallel.
6. The orchestrator proceeds immediately to its own parallel analysis.

### Step 2: Collect

1. Wait for the background dispatch notification — do NOT poll, sleep,
   or proactively check status.
2. Read the peer-runner JSON, then read `envelope_path` for the parsed
   companion envelope (or `stdout_path` / `stderr_path` when diagnosing a
   degraded run). The envelope keys are pinned by
   `companions/contract.md` §4.2:
   `{status, peer_host, peer_model, stdout, exit_code, [error, metadata]}`.
3. Classify by `status`: `success` → parse the peer answer;
   `peer_error` (`error.kind: peer_run_error`) → peer malformed/empty;
   `companion_error` with `error.kind ∈ {peer_cli_not_found,
   peer_unauthenticated, peer_invocation_error}` → degrade to local-only;
   `companion_error` with `error.kind: companion_misuse` → adapter bug,
   surface as a runtime error (not a degradation case).
4. If the peer failed or returned empty output, record the failure and
   proceed to Synthesize with orchestrator-only results (graceful
   degradation, see *Failure Handling*).

### Step 3: Synthesize

Classify every finding, recommendation, direction, or conclusion from
both sources into one of four base synthesis categories.

#### Base Synthesis Categories

| Category   | Condition                                          | Presentation                                        |
|------------|----------------------------------------------------|-----------------------------------------------------|
| AGREED     | Both orchestrator and peer reached same conclusion | Present with elevated confidence. Label: **[Both]** |
| LOCAL-ONLY | Orchestrator found it, peer did not                | Present normally. Label: **[Local]**                |
| PEER-ONLY  | Peer found it, orchestrator did not                | Present normally. Label: **[Peer]**                 |
| CONFLICT   | Orchestrator and peer disagree                     | Present both with evidence. Ask the user to decide  |

The four names — `AGREED`, `LOCAL-ONLY`, `PEER-ONLY`, `CONFLICT` — are
the canonical public vocabulary of this protocol. Their semantics are
schema-stable: renaming or removing any of the four is a breaking
change; adding a fifth category is a non-breaking, schema-minor step.

The labels (`[Local]` / `[Peer]` / `[Both]`) are host-agnostic — they
refer to *orchestrator* and *peer*, never specifically to one named host.
This reflects bidirectional symmetry: the same synthesis produced from
either side should be structurally indistinguishable except for
capability differences.

**Artifact label policy.** These source-of-discovery labels live in
**workflow phase notes** for orchestration transparency. They are
**stripped from saved business artifacts** — a saved brief, plan,
canvas, or critique report carries no `[Local]` / `[Peer]` / `[Both]`
marker, per the Ensemble Label Policy in
`../../investigate/references/business-brief-spec.md`. A reader of the
artifact should not be able to tell whether the ensemble ran at all.

### State Bookkeeping (Stage 2.5+)

Ensemble dispatch and synthesis are recorded in **two complementary
locations**, both through founder's `../../../scripts/state.mjs`:

1. **Frontmatter** — programmatic bookkeeping via the `pending_ensemble`
   and `ensemble_results` schema fields. `ensemble-pending` records that
   a dispatch began (idempotent on `run_id`); `ensemble-commit` performs
   the atomic three-step mutation (pop matching pending → append result →
   prune to the retention cap). Command-managed ensembles normally let
   `peer-runner.mjs run --kind ensemble` record the pending row before
   spawning the companion.
2. **Markdown body** — human-readable phase notes appended via
   `state.mjs append --phase-note ...`:
   - in-flight marker: `### Ensemble launched: <type> at <iso-utc>`
   - synthesis result: `### Ensemble synthesis: <type> verdict=<...>`
     followed by the AGREED / LOCAL-ONLY / PEER-ONLY / CONFLICT breakdown

Frontmatter is the machine-parsable retrospective surface; the body is
the human-readable narrative. Both are written under the per-file lock
and MAY be written in separate calls.

---

## Prompt Construction Rules

All peer prompts are XML block structures passed to the companions `task`
subcommand via `--prompt-file <path>`. The orchestrator materializes the
prompt to a tempfile to keep it out of `ps aux` and avoid the `ARG_MAX`
ceiling.

### Required blocks for every ensemble prompt

- `<task>`: Concrete business job description with genericized context
- `<structured_output_contract>`: Exact output shape
- `<grounding_rules>`: Ground claims in evidence; label inferences
  `INFERENCE:`; vendor/marketing claims need corroboration

### Additional blocks by ensemble point type

- **Frame**: `<privacy_contract>`
- **Brainstorm** (decide phase): optional `<axis_awareness>` — present
  only when the orchestrator resolved a business preset
  (`registry_fallback === false`) AND is in command mode (see §Brainstorm
  presence rule); plus `<privacy_contract>`
- **Explore** (investigate analysis profile): add `<research_mode>`,
  `<privacy_contract>`
- **Investigate** (root-cause profile): add `<verification_loop>`,
  `<missing_context_gating>`, `<privacy_contract>`
- **Plan-verify** (compose phase): add `<dig_deeper_nudge>`,
  `<completeness_contract>`, `<privacy_contract>`
- **Review** (critique default profile): add `<dig_deeper_nudge>`,
  `<privacy_contract>`
- **Refine-verify** (refine phase): add `<verification_loop>`,
  `<privacy_contract>`
- **Adversarial-scan** (critique red-team profile): add
  `<dig_deeper_nudge>`, `<adversarial_mindset>`, `<privacy_contract>`
- **Research-scan** (investigate business-brief profile): add
  `<citation_contract>`, `<privacy_contract>` (full prompt construction
  in `../../investigate/references/business-brief-ensemble.md` §Prompt
  Construction)

Every founder ensemble prompt carries a `<privacy_contract>` block —
external transmission to the peer host is treated with the same
discipline as web search (see *Privacy* below). This is the load-bearing
difference from the engineer protocol, where most points omit it.

### Do not pass --model or --effort

Each host's config file is the single source of truth for model, effort,
and service tier. Passing these flags would override the user's global
configuration.

---

## Independence Rule

The peer must analyze independently. Do not include the orchestrator's
in-progress findings, hypotheses, draft conclusions, confidence ratings,
or intermediate results in the peer prompt.

Both hosts receive the same raw context: the genericized topic /
directions / artifact, the market geographies (jurisdictions) in scope,
and the user's original business request.

**Single exception**: the **Plan-verify** ensemble. The peer receives the
orchestrator's genericized draft plan as explicit input, because the task
is to find gaps in that specific plan. The exception is scoped to the
plan text — the orchestrator's *judgments about* the plan are still
withheld.

The Independence Rule is explicitly **bidirectional**: when the local
host is Claude, Claude does not leak its findings into the
`codex-companion` prompt; when the local host is Codex, Codex does not
leak its findings into the `claude-companion` prompt.

---

## Privacy

founder's privacy gate covers external **peer-host dispatch** in addition
to web search. Specifically: proprietary venture concepts,
interview/customer data, and unpublished business material **pass an
explicit gate before BOTH web search AND peer-host dispatch** — the gate
is checked once and governs every external transmission in the phase.

- Everything transmitted in the peer prompt (topic, directions,
  sub-questions, draft plan, artifact under review) is treated as
  external transmission. Apply the same genericization rules as
  WebSearch — no proprietary venture concept, customer/interview
  identities, unpublished product or pricing names, internal financials,
  or pasted internal documents.
- The `<privacy_contract>` block in every prompt instructs the peer to
  refrain from fabricating or echoing proprietary identifiers and from
  de-anonymizing a genericized concept to a specific named company or
  product.
- If the genericization substitution is generic (e.g., "AI scheduling
  software for healthcare providers"), pass the substituted form to the
  peer too — never the original pre-genericization value.

The privacy gate is **bidirectional** — the same discipline applies
whether the local host is Claude (sending to Codex) or Codex (sending to
Claude). **The pre-genericization value MUST never leave the local
host.** When the user declines genericization or aborts the session, do
NOT dispatch to the peer. See
`../../investigate/references/business-brief-spec.md` § Privacy Gate for
the canonical rule.

---

## Ensemble Point Types

Each `/founder:<verb>` command's phases dispatch one or more of these
point types. The verb→type mapping is in each command's body. All types
use the companions `task --prompt-file <path>` subcommand per the
Bidirectional invocation pattern above.

### Frame (frame phase)

- **Purpose**: Independent business opportunity-model framing
- **Subcommand**: `task`
- **Prompt template**:

  ```xml
  <task>
  Given this genericized business evidence, independently build a business
  opportunity model: problem/opportunity, customer + job-to-be-done, value
  hypothesis, business-model sketch, constraints, validation criteria, key
  risks, and explicit out-of-scope items. Do not see the local host's
  model — produce a fresh, independent one.
  Evidence: {genericized investigate findings or user-supplied context}
  Jurisdiction(s): {market geographies in scope, or "unspecified"}
  </task>

  <structured_output_contract>
  Return one opportunity model:
  1. Problem / Opportunity (1-2 sentences)
  2. Customer + Job-to-be-Done
  3. Value hypothesis (the wedge / unfair-advantage thesis)
  4. Business-model sketch (revenue model + rough unit-economics direction)
  5. Constraints (regulatory / capital / time / capability / market-timing)
  6. Validation criteria (measurable evidence that would confirm or refute)
  7. Key risks (market / competitive / regulatory / unit-economics /
     safety / execution) + an early-detection signal each
  8. Out of scope
  Mark uncertain fields [to be validated] rather than guessing.
  </structured_output_contract>

  <privacy_contract>
  The evidence has been pre-genericized. Do not fabricate or echo
  proprietary identifiers, company names, or customer names, and do not
  de-anonymize a genericized concept to a specific named company/product.
  </privacy_contract>

  <grounding_rules>
  Frame the opportunity from the observable evidence; do not yet compare
  directions (that belongs to /founder:decide). Where a goal or
  constraint is inferred rather than evidenced, label it INFERENCE:.
  </grounding_rules>
  ```

- **Synthesis**: Compare opportunity models. AGREED items elevate
  confidence in the framing. CONFLICT items surface to the user as an
  ambiguous opportunity boundary that must be reconciled before
  decide / compose.

### Brainstorm (decide phase)

- **Purpose**: Independent business-direction generation
- **Subcommand**: `task`
- **Prompt template**:

  ```xml
  <task>
  Given this business decision, independently propose 2-3 candidate
  directions with tradeoffs.
  Decision: {genericized decision context from the Business Task Profile}
  Market context: {genericized market / segment / stage}
  </task>

  <axis_awareness>
  Preset: {preset-id resolved from decision-axes.yml}
  Size: {minor | standard | major}
  Axes:
    - id: <axis-id>; label: <label>; question: <core question>; role: <decisive | supporting | gate>
    - ...
  Weights: {comma-separated id:weight | "uniform"}
  </axis_awareness>

  <structured_output_contract>
  For each direction:
  1. Name and one-sentence summary
  2. Key tradeoffs — when <axis_awareness> is present, express each
     tradeoff against the named axes' labels and roles (decisive market /
     unit-economics; supporting; gate-style regulatory / safety)
  3. Risk areas (market / competitive / regulatory / unit-economics /
     safety / execution)
  4. Rough unit-economics direction (CAC vs value-captured intuition)
  </structured_output_contract>

  <privacy_contract>
  The decision context has been pre-genericized. Do not fabricate or echo
  proprietary identifiers and do not de-anonymize a genericized concept.
  </privacy_contract>

  <grounding_rules>
  Base directions on the actual market context provided. Marketing claims
  ("huge market", "no competition") require a source or are marked
  INFERENCE:. Do not assume capital or capability the brief does not state.
  </grounding_rules>
  ```

- **Presence rule**: The `<axis_awareness>` block is emitted only when
  **both** hold: (1) the orchestrator resolved a business preset —
  `registry_fallback === false` on the `ResolvedDecisionContext` written
  by `../../../scripts/decide-registry.mjs resolve` (per ADR-0027 §5.6) —
  AND (2) the orchestrator is in **command mode** (`/founder:decide` or
  `$founder:decide`). Auto-activated mode never reaches a peer dispatch
  (per the decide SKILL's auto-activated path), so the block is omitted
  there. When either condition fails, the block is omitted and the peer
  falls back to free-form 2-3 directions — graceful degradation.
- **Snapshot rule**: When `<axis_awareness>` is present, the orchestrator
  captures `{preset_id, axes, size, weights}` in memory before dispatch
  and synthesis consumes that in-memory snapshot, NOT a re-read of
  `decision-axes.yml`. This pins the axis frame both sides shared even if
  the registry changes mid-dispatch. The two decisive axes (시장성
  Market-Attractiveness, 단위경제 Unit-Economics) are present in every
  founder preset (the ≥2-decisive invariant), so synthesis can always
  rank directions on them.
- **XML escaping** (editorial rule): axis labels/questions are free-text
  YAML fields. Registry authors MUST keep them free of the XML predefined
  entities (`&`, `<`, `>`, `"`, `'`) since the `<axis_awareness>` emitter
  does NOT escape on emission. The shipped presets (`default`, `compact`)
  are escape-free; future presets must follow the same constraint.
- **Synthesis**: Merge direction sets per the four base categories. Add
  PEER-ONLY directions; elevate confidence for AGREED; present CONFLICT
  directions both ways for the user. When `<axis_awareness>` was present,
  additionally rate each PEER-ONLY direction against the snapshotted
  business axes before merging; tag a direction `[Peer · unmapped]` when
  its justification uses a concept orthogonal to the snapshot's axes, and
  surface the unmapped vocabulary so the user MAY widen the preset. This
  is a presentation sub-label on top of the four base buckets, not a
  fifth category.

### Explore (investigate phase, analysis profile)

- **Purpose**: Independent market / landscape / competitive analysis
- **Subcommand**: `task`
- **Prompt template**:

  ```xml
  <task>
  Analyze the market and competitive landscape relevant to this business
  question. Identify: addressable segments, demand signals, incumbent /
  substitute players, pricing/packaging patterns to learn from, and the
  regulatory surface that governs entry.
  Question: {genericized business question}
  Jurisdiction(s): {market geographies in scope, or "unspecified"}
  </task>

  <structured_output_contract>
  Return:
  1. Segments and demand signals (with sources)
  2. Incumbents / substitutes and how they price/package (with sources)
  3. Entry patterns to follow or avoid (with sources)
  4. Regulatory / competitive risk areas that could block or erode entry
  </structured_output_contract>

  <research_mode>
  Separate observed facts from inferences.
  Prefer breadth across the landscape first, then depth where it changes
  the recommendation. Prefer official-stats / market-intelligence tiers
  for hard numbers.
  </research_mode>

  <privacy_contract>
  The question has been pre-genericized. Do not fabricate or echo
  proprietary identifiers and do not de-anonymize a genericized concept.
  </privacy_contract>

  <grounding_rules>
  Every claim references a specific source. Market / pricing figures carry
  an as-of date and a jurisdiction tag. Vendor claims need corroboration
  or are marked vendor-claim/estimate.
  </grounding_rules>
  ```

- **Synthesis**: Merge landscape findings. The orchestrator provides
  deep per-segment analysis; the peer provides a holistic cross-cutting
  view. Flag segments / incumbents found by only one side.

### Plan-verify (compose phase)

Applies to all `compose` profiles (`plan`, `canvas`, `validation-plan`):
the peer receives the genericized draft artifact and returns gaps.

- **Purpose**: Find gaps in the orchestrator's venture plan — missing
  risks, unsupported unit-economics, sequencing problems, untested
  assumptions
- **Subcommand**: `task`
- **Independence exception**: Receives the orchestrator's genericized
  draft plan as input
- **Prompt template**:

  ```xml
  <task>
  Review this genericized business plan for gaps: missing risks,
  unsupported or internally inconsistent unit-economics, sequencing
  errors in the go-to-market or milestones, and assumptions presented as
  facts without a validation step.

  Plan:
  {orchestrator's genericized draft plan / canvas / validation-plan}

  Original business request:
  {genericized user request}
  </task>

  <structured_output_contract>
  Return:
  1. Gaps: missing risks, costs, or considerations
  2. Sequencing issues: steps that should come earlier/later
  3. Unit-economics holes: numbers asserted without support, or that do
     not reconcile across sections
  4. Untested assumptions: claims that need a validation experiment
  </structured_output_contract>

  <dig_deeper_nudge>
  Check second-order dependencies (a channel that assumes a partnership,
  a margin that assumes a volume), and what must be true for the plan's
  riskiest assumption to hold.
  </dig_deeper_nudge>

  <completeness_contract>
  Do not stop at surface observations. Trace each milestone's
  dependencies and each financial line's supporting assumption fully.
  </completeness_contract>

  <privacy_contract>
  The plan has been pre-genericized. Do not fabricate or echo proprietary
  identifiers and do not de-anonymize a genericized concept.
  </privacy_contract>

  <grounding_rules>
  Ground every gap in a specific plan section or a market reality. Label
  inferences INFERENCE:.
  </grounding_rules>
  ```

- **Synthesis**: Incorporate valid gaps into the plan and its validation
  backlog. Adjust sequencing for valid ordering issues. Note CONFLICT
  items for user resolution.

### Review (critique phase, default profile)

- **Purpose**: Independent multi-perspective review of a business
  artifact (a venture plan, brief, canvas, or strategy)
- **Subcommand**: `task`
- **Prompt template**:

  ```xml
  <task>
  Review this genericized business artifact independently from a
  multi-perspective viewpoint. Identify weaknesses across:
  market-attractiveness, unit-economics, willingness-to-pay,
  competitive-intensity, regulatory-exposure, safety/harm-risk, execution
  feasibility, and evidence quality (claims presented as facts without
  support).

  Artifact (section text + the claims it rests on):
  {orchestrator-collected genericized artifact}

  Business context: {genericized market / segment / stage}
  </task>

  <structured_output_contract>
  Return findings as:
  - section/claim — severity (CRITICAL|MAJOR|MINOR|SUGGESTION) —
    perspective — description
  Group by severity. CRITICAL = a fatal flaw or an unmitigated gate
  (regulatory / safety) that blocks the venture; SUGGESTION = an
  improvement that does not gate the decision. Include "Looks Strong"
  observations at the end.
  </structured_output_contract>

  <dig_deeper_nudge>
  Trace the artifact's load-bearing assumptions. What must be true for the
  unit-economics to hold? What incumbent response would erode the wedge?
  Which claim, if wrong, collapses the plan?
  </dig_deeper_nudge>

  <privacy_contract>
  The artifact has been pre-genericized. Do not fabricate or echo
  proprietary identifiers and do not de-anonymize a genericized concept.
  </privacy_contract>

  <grounding_rules>
  Every finding references a specific section or claim. Label inferences
  INFERENCE:. A weakness asserted without a market or logical basis is
  itself a low-grade finding.
  </grounding_rules>
  ```

- **Synthesis**: Merge findings by section/claim. Same target + same
  issue → deduplicate, take higher severity. Unique findings → label
  source. The orchestrator judges validity (drop invalid findings); it
  does not ask the user "is this an issue?".

### Investigate (investigate phase, root-cause profile)

- **Purpose**: Independent diagnosis of a business underperformance or
  failure (a stalled funnel, churn, a missed forecast, a flat launch)
- **Subcommand**: `task`
- **Prompt template**:

  ```xml
  <task>
  Independently diagnose the most likely root cause of this business
  symptom. Do not follow any pre-existing hypothesis — start from the
  observed evidence and reason through the funnel / unit-economics /
  market fit.
  Symptom: {genericized symptom — e.g. "trial-to-paid conversion fell from
  X% to Y% after a pricing change", genericized}
  Evidence: {genericized metrics / context}
  </task>

  <structured_output_contract>
  Return:
  1. Most likely root cause with evidence
  2. Confidence (HIGH/MEDIUM/LOW)
  3. Alternative causes considered and why rejected
  4. Suggested verification step (the cheapest test that would confirm)
  </structured_output_contract>

  <verification_loop>
  Before finalizing, verify that the proposed root cause explains ALL the
  observed evidence, not just the most salient symptom.
  </verification_loop>

  <missing_context_gating>
  If critical context is missing (a metric, a cohort, a timeframe), state
  exactly what remains unknown rather than guessing.
  </missing_context_gating>

  <privacy_contract>
  The symptom and metrics have been pre-genericized. Do not fabricate or
  echo proprietary identifiers and do not de-anonymize a genericized
  concept.
  </privacy_contract>

  <grounding_rules>
  Every claim references specific evidence. Label inferences INFERENCE:.
  </grounding_rules>
  ```

- **Synthesis**: Cross-validate. AGREED → high confidence. PEER-ONLY →
  treat as an additional hypothesis to verify with a targeted check.
  CONFLICT → present both with evidence, ask the user.

### Research-scan (investigate phase, business-brief profile)

- **Purpose**: Independent topic-bound external research producing cited
  business evidence per sub-question
- **Subcommand**: `task`
- **Canonical contract**:
  `../../investigate/references/business-brief-ensemble.md` (the full
  bidirectional protocol — privacy gate, the 5-tier business source
  taxonomy, citation remapping, Path A / Path B, dispatch via
  `../../../scripts/peer-runner.mjs`). This entry exists for parallelism
  with Explore / Investigate; the research-scan prompt and synthesis
  machinery live in that file. Do NOT duplicate it here — cross-reference
  it from the investigate command's business-brief profile.
- **Synthesis**: Apply the bidirectional Independence Rule from the
  canonical contract — Path A locally verify and cite the PEER-ONLY claim,
  Path B move it to Open Questions. Citation numbering remaps to local
  capture order; the peer's internal labels MUST NOT be copied verbatim.
  Source-of-discovery labels live in workflow phase notes only — the saved
  brief strips them per the Ensemble Label Policy.

### Refine-verify (refine phase)

- **Purpose**: Independent verification of an applied revision to a
  business artifact — does it actually resolve the finding, without
  introducing a new inconsistency or a new gate exposure?
- **Subcommand**: `task`
- **Prompt template**:

  ```xml
  <task>
  Review this revision to a business artifact independently. Verify the
  change resolves the stated finding, does not introduce a new internal
  inconsistency (e.g., a margin that no longer reconciles with the
  go-to-market), and does not open a new regulatory / safety exposure.

  Revision (before → after of the changed sections):
  {orchestrator-collected genericized revision}

  Original finding / feedback:
  {genericized critique finding or feedback context}
  </task>

  <structured_output_contract>
  Return:
  1. Resolution assessment (does the revision address the stated finding?)
  2. Consistency risks (what other section may now contradict the change?)
  3. New gate exposure (did the change introduce a regulatory / safety
     concern that was not there before?)
  4. New findings discovered while reviewing the revision
  </structured_output_contract>

  <verification_loop>
  Trace the changed sections end-to-end. Check that downstream sections
  (unit-economics, go-to-market, milestones) still reconcile with the
  revised section.
  </verification_loop>

  <privacy_contract>
  The revision has been pre-genericized. Do not fabricate or echo
  proprietary identifiers and do not de-anonymize a genericized concept.
  </privacy_contract>

  <grounding_rules>
  Every claim references a specific section of the revision. Label
  inferences INFERENCE:.
  </grounding_rules>
  ```

- **Synthesis**: Same as Review, scoped to the applied revision. A
  peer-flagged regression (a new inconsistency or gate exposure) pauses
  the refine for user direction rather than auto-proceeding.

### Adversarial-scan (critique phase, red-team profile)

- **Purpose**: Adversarial pre-mortem of an entire venture or strategy
  when critique runs over the whole plan (`/founder:critique
  --profile=red-team`)
- **Subcommand**: `task`
- **Focus text**: derived from the red-team sub-focus (the founder
  Risk-class taxonomy); embedded in the `<task>` block:
  - Market: `"demand assumptions, market-size inflation, timing risk,
    segment-reachability optimism"`
  - Unit-economics: `"CAC/LTV assumptions, contribution-margin path,
    pricing power, burn/runway fragility"`
  - Competitive: `"incumbent response, substitutes, defensibility
    erosion, race-to-the-bottom"`
  - Regulatory: `"licensing/compliance gaps, jurisdiction exposure,
    policy-change risk"` (gate-like)
  - Execution: `"team/capability gaps, dependency risk, go-to-market
    assumptions, operational fragility"`
  - Full: `"hidden assumptions, fatal flaws, founder bias,
    what-must-be-true failures"`
- **Prompt template**:

  ```xml
  <task>
  Conduct an adversarial pre-mortem of the specified venture/strategy.
  Assume it failed 18 months from now — look for the hidden assumptions,
  fatal flaws, and failure modes that single-perspective review misses.

  Focus: {focus text from the sub-focus above}

  Venture / strategy (genericized plan + the claims it rests on):
  {orchestrator-collected genericized scope}
  </task>

  <structured_output_contract>
  Return findings as:
  - assumption/section — severity (CRITICAL|MAJOR|MINOR|SUGGESTION) —
    perspective: adversarial-scan — description
  Group by severity. For each finding, state the specific failure
  scenario (what triggers it, what breaks). Include "Looks Resilient"
  observations at the end.
  </structured_output_contract>

  <dig_deeper_nudge>
  Trace second-order effects. What downstream plan depends on the
  assumption being questioned? What would break if it fails?
  </dig_deeper_nudge>

  <adversarial_mindset>
  Adopt the perspective of a skeptical investor, an incumbent's strategy
  team, and a future founder writing the post-mortem. What is being
  assumed silently? Where is the venture fragile under a competitor
  response or a regulatory change?
  </adversarial_mindset>

  <privacy_contract>
  The venture has been pre-genericized. Do not fabricate or echo
  proprietary identifiers and do not de-anonymize a genericized concept.
  </privacy_contract>

  <grounding_rules>
  Every finding references a specific assumption or plan section. Label
  inferences INFERENCE:.
  </grounding_rules>
  ```

- **Synthesis**: Merge with orchestrator findings. Deduplicate by
  assumption/section. Source-label all findings. An unmitigated gate
  (regulatory / safety) surfaced here is CRITICAL by definition.

---

## Failure Handling

### Peer unavailable, not installed, or unauthenticated

- **Detect**: companion discovery returns empty (the `companions` plugin
  is not installed), or `error.kind ∈ {peer_cli_not_found,
  peer_unauthenticated, peer_invocation_error}`.
- **Action**: Skip the dispatch silently. Proceed with orchestrator-only
  analysis.
- **Surface**: Mention in the user-facing completion summary that the
  ensemble was unavailable. Do NOT label findings inside the saved
  artifact.

### Peer timeout or runtime error

- **Detect**: `status: peer_error` with `error.kind: peer_run_error`, or
  the background dispatch exits unmappably.
- **Action**: Record the failure mode internally; proceed
  orchestrator-only.
- **Surface**: Same as above.

### Peer returns empty or malformed output

- **Detect**: Envelope `status: success` but `stdout` parses to no
  findings, or is structurally valid but missing required fields for some
  findings.
- **Action**: Parse only the findings that pass structural validation;
  discard the rest. Continue with the salvageable subset.
- **Surface**: Mention in the completion summary that ensemble coverage
  was partial.

### Large artifact / large venture scope

- **Detect**: For Review / Adversarial-scan, the collected artifact scope
  exceeds a comfortably-promptable size (a full multi-section plan plus
  its supporting briefs), or the peer task produces no output after a long
  wait on a known-large scope.
- **Action**: Segment by artifact section (or by Risk-class focus for
  adversarial-scan). Issue one peer `task` per segment and aggregate
  findings at synthesis time, deduplicating shared concerns.
- **Surface**: "Scope exceeds slicing threshold — peer review issued in
  K segments."

### Graceful degradation principle

Ensemble failure must never block the workflow. Orchestrator-only results
are always sufficient to proceed — the brief, plan, or critique report is
always assembled and saved on the local-only path. The peer adds value
when available but is not required, and the saved artifact never reveals
whether the ensemble ran.

---

## Related

- `./orchestration.md` — founder's dynamic-orchestration framework and the
  Business Task Profile (Step 1) that every verb builds; records the
  `Ensemble Affinity` axis this protocol does not gate on.
- `../../investigate/references/business-brief-ensemble.md` — the
  canonical research-scan contract (5-tier source taxonomy, citation
  remapping, Path A / Path B). This file cross-references it for the
  research-scan point rather than duplicating it.
- `../../investigate/references/business-brief-spec.md` — canonical brief
  structure, privacy gate, and the Ensemble Label Policy that strips
  `[Local]` / `[Peer]` / `[Both]` from saved artifacts.
- `../../decide/references/decision-axes.yml` — the business decision-axis
  registry the Brainstorm point's `<axis_awareness>` block reads.
- `../../../scripts/peer-runner.mjs` — founder's managed peer runner
  (resolves + invokes the companion, writes the ledger, records
  `pending_ensemble`).
- `../../../scripts/dispatch-peer.mjs` — founder's blocking compatibility
  dispatcher for legacy/raw callers.
- `companions/contract.md` v0.1.1 — wire-spec contract for both companion
  bridges (`claude-companion`, `codex-companion`).
- `docs/adr/0008-companion-distribution-model.md` — companion
  distribution (cache-glob discovery + env override).
- `docs/adr/0010-plugin-boundary-policy.md` — 4-layer composition,
  naming, §5 no-import.
- `docs/adr/0036-founder-persona-business-planning.md` — the founder
  persona decision; SD6 / F7 specify the nine business-anchored point
  templates this file lands.
