# Ensemble Protocol

Defines how Claude and Codex operate as a dual-model **bidirectional**
ensemble within the engineer plugin. Either host can be the
**orchestrator** (the host where the user is currently invoking the
skill); the other is the **peer**. The orchestrator drives the
workflow, dispatches the peer for independent parallel analysis, and
synthesizes both perspectives into a unified result.

The Stage 1 `plugins/research` plugin already proves this
bidirectional pattern: when invoked on Claude Code, it calls
`codex-companion`; when invoked on Codex CLI, it calls
`claude-companion`. The engineer plugin adopts the same symmetry
across all six verbs.

---

## Always-max policy

Every phase boundary in `/engineer:*` commands automatically
dispatches the peer ensemble. **There is no `LOW` skip.** Engineer's
user value is maximum-quality output; the peer call is paid at every
phase boundary regardless of affinity rating.

The peer call uses the host's configured model with maximum
effort/depth. Skills do **not** pass `--model` or `--effort` flags —
each host's config file (`~/.codex/config.toml`,
`~/.claude/settings.json`, etc.) is the single source of truth.

`Ensemble Affinity` (LOW / MEDIUM / HIGH) is retained as a Task
Profile axis (records context about the task) for orchestrator-side
agent-count decisions, but does **not** gate dispatch.

---

## Bidirectional invocation pattern

Direction is symmetric:

| Orchestrator | Peer        | Peer invocation                                                |
|--------------|-------------|----------------------------------------------------------------|
| Claude Code  | Codex CLI   | `codex-companion` (resolved via `companions` plugin discovery) |
| Codex CLI    | Claude Code | `claude-companion` (resolved via `companions` plugin discovery)|

Both companion CLIs ship in the agentic-plugins `companions` plugin
and implement `companions/contract.md` v0.1.1. The contract exposes a
single subcommand `task --prompt-file <path>` accepting an XML
prompt. The engineer ensemble protocol expresses every ensemble point
type as a `task` invocation with a type-specific prompt template;
review-style ensembles (critique, refine-verify, adversarial-scan)
embed review semantics in the prompt itself rather than relying on
separate subcommands.

The orchestrator is the currently-invoking host; the peer is the
other host. Skills never hard-code "Claude side" or "Codex side" —
they refer to *orchestrator* and *peer*.

Discovery uses the canonical `companions/discover-peer.mjs` library
extracted in Stage 2 Deliverable B (per ADR-0008 §(e)
*Install-order semantics + graceful degradation*). The host adapter
calls it before any dispatch; on discovery failure, the dispatch is
skipped silently per *Failure Handling* below.

---

## When This Protocol Applies

Activates automatically at every command-defined phase boundary in
`/engineer:*` commands. Each command file specifies which phase
invokes which ensemble point type (see *Ensemble Point Types*
below).

Does NOT apply to:
- Skills invoked outside any `/engineer:*` command (auto-activated
  mode runs without ensemble unless the invoking command activated
  it).
- Binary confirmations or progress updates.
- Internal orchestration decisions.

---

## Execution Pattern

Every ensemble point follows three steps: **Launch**, **Collect**,
**Synthesize**.

### Step 1: Launch

1. Determine the ensemble point type (see *Ensemble Point Types*
   below).
2. Resolve the peer companion via `companions/discover-peer.mjs`
   (per ADR-0008 §(b) *Resolution order* and §(b.1) *Resolution
   precedence*). Honor `AGENTIC_COMPANIONS_ROOT` if the user
   provided an override.
3. Construct the peer prompt per the type-specific template (see
   *Prompt Construction Rules*). All ensemble types use the
   companions `task --prompt-file <path>` subcommand; the
   ensemble's intent is encoded entirely in the XML prompt body.
4. Invoke the companion as a background task with the prompt
   written to a tempfile. The host-shared canonical wrapper
   (`plugins/engineer/scripts/dispatch-peer.mjs`, added in
   Deliverable D) implements this dispatch — both Claude and Codex
   sides import it. The orchestrator's slash command (Claude) or
   skill agent (Codex) is responsible for arranging background
   execution per its own host primitives (Bash `run_in_background`
   on Claude; Codex `task` subcommand on Codex side).
5. The orchestrator proceeds immediately to its own parallel
   analysis.

### Step 2: Collect

1. Orchestrator completes its own analysis (Task tool agents on
   Claude side, in-context analysis on Codex side, etc.).
2. Read the peer output from the completed background task.
3. If the peer has not finished yet, wait for the background
   notification — do not poll or sleep.
4. If the peer failed or returned empty output, record the failure
   and proceed to Synthesize with orchestrator-only results
   (graceful degradation, see *Failure Handling*).

### Step 3: Synthesize

Classify every finding, recommendation, or conclusion from both
sources into one of four base synthesis categories.

#### Base Synthesis Categories

| Category   | Condition                                          | Presentation                                       |
|------------|----------------------------------------------------|----------------------------------------------------|
| AGREED     | Both orchestrator and peer reached same conclusion | Present with elevated confidence. Label: **[Both]** |
| LOCAL-ONLY | Orchestrator found it, peer did not                | Present normally. Label: **[Local]**               |
| PEER-ONLY  | Peer found it, orchestrator did not                | Present normally. Label: **[Peer]**                |
| CONFLICT   | Orchestrator and peer disagree                     | Present both with evidence. Ask user to decide     |

The four names — `AGREED`, `LOCAL-ONLY`, `PEER-ONLY`, `CONFLICT` —
are the canonical public vocabulary of this protocol. Their
semantics are schema-stable: renaming or removing any of the four
is a breaking change; adding a fifth category is a non-breaking,
schema-minor step.

The labels (`[Local]` / `[Peer]`) are host-agnostic — they refer to
*orchestrator* and *peer*, never specifically Claude or Codex. This
reflects bidirectional symmetry: the same brief produced from
Claude's side and from Codex's side should be structurally
indistinguishable except for capability differences.

Synthesis output replaces the standard single-model output. Follow
the Presentation Mode Protocol (`presentation-protocol.md`) for the
synthesized result.

### State Bookkeeping (Stage 2)

Stage 2 records ensemble dispatch and synthesis results in the
workflow file's **Markdown body** as phase notes — not in frontmatter.
ADR-0011 §2 schema 1 is closed; the frontmatter set is fixed and
extending it requires a follow-up ADR (out of Stage 2 scope).

Each phase note appended via `state.mjs append --phase-note ...`
captures the ensemble in human-readable form:
- in-flight markers: `### Ensemble launched: <type> at <iso-utc>`
  near the phase boundary
- synthesis results: `### Ensemble synthesis: <type> verdict=<...>`
  followed by the AGREED / LOCAL-ONLY / PEER-ONLY / CONFLICT breakdown

This satisfies the "every dispatch is recorded" principle without
amending ADR-0011 schema 1. Frontmatter promotion of
`pending_ensemble` / `ensemble_results` is explicitly deferred to a
future ADR (post-Stage 2).

---

## Prompt Construction Rules

All peer prompts are XML block structures passed to the companions
`task` subcommand via `--prompt-file <path>`. The orchestrator
materializes the prompt to a tempfile to keep it out of `ps aux` and
avoid the `ARG_MAX` ceiling.

### Required blocks for every ensemble prompt

- `<task>`: Concrete job description with repository context
- `<structured_output_contract>`: Exact output shape
- `<grounding_rules>`: Ground claims in code/evidence; label
  inferences

### Additional blocks by ensemble point type

- **Investigate** (analysis profile): add `<research_mode>`
- **Investigate** (root-cause profile): add `<verification_loop>`,
  `<missing_context_gating>`
- **Plan-verify** (compose phase): add `<dig_deeper_nudge>`,
  `<completeness_contract>`
- **Review** (critique phase, default profile): add
  `<dig_deeper_nudge>`
- **Refine-verify** (refine phase): add `<verification_loop>`
- **Adversarial-scan** (critique phase, full-codebase profile):
  add `<dig_deeper_nudge>`, `<adversarial_mindset>`
- **Research-scan** (investigate phase, cited-brief profile): add
  `<citation_contract>`, `<privacy_contract>` (full prompt
  construction in
  `skills/investigate/references/cited-brief-ensemble.md` §
  Prompt Construction)

### Do not pass --model or --effort

Each host's config file is the single source of truth for model,
effort, and service tier. Passing these flags would override the
user's global configuration.

---

## Independence Rule

The peer must analyze independently. Do not include the
orchestrator's in-progress findings, hypotheses, draft conclusions,
or intermediate results in the peer prompt.

Both hosts receive the same raw context:

- Source code (via the host's own file access)
- Git state (via the host's own git access)
- The user's original request or task description

**Single exception**: Plan-verify ensemble. The peer receives the
orchestrator's draft plan as explicit input, because the task is to
find gaps in that specific plan.

---

## Ensemble Point Types

Each `/engineer:<verb>` command's phases dispatch one or more of
these point types. The verb→type mapping is in each command's body.
All types use the companions `task --prompt-file <path>` subcommand
per the Bidirectional invocation pattern above.

### Frame (frame phase)

- **Purpose**: Independent problem-model framing
- **Subcommand**: `task`
- **Prompt template**:

  ```xml
  <task>
  Given this evidence and user request, independently propose a problem
  model: problem statement, goals, audience, constraints, success
  criteria, risks, and explicit out-of-scope items.
  Evidence: {investigate findings or user-supplied context}
  Request: {user's framing trigger}
  </task>

  <structured_output_contract>
  Return:
  1. Problem statement (1-2 sentences)
  2. Goals (concrete description of success)
  3. Audience (consumer of the result)
  4. Constraints (tech / time / scope / compatibility limits)
  5. Success criteria (measurable)
  6. Risks (with detection signal)
  7. Out of scope (deliberately deferred)
  </structured_output_contract>

  <grounding_rules>
  Frame the problem from observable evidence; do not propose
  approaches (deciding belongs to /engineer:decide). Where a goal or
  constraint is inferred rather than observed, label it explicitly.
  </grounding_rules>
  ```

- **Synthesis**: Compare problem models. AGREED items elevate
  confidence in the framing. CONFLICT items surface to the user as
  an ambiguous problem boundary that must be reconciled before
  decide / compose.

### Brainstorm (decide phase)

- **Purpose**: Independent approach generation
- **Subcommand**: `task`
- **Prompt template**:

  ```xml
  <task>
  Given this design decision, independently propose 2-3 approaches with
  tradeoffs.
  Decision: {user's decision context from task profile}
  Repository: {repo context}
  </task>

  <structured_output_contract>
  For each approach:
  1. Name and one-sentence summary
  2. Key tradeoffs (pros and cons)
  3. Risk areas
  4. Estimated scope (files/layers affected)
  </structured_output_contract>

  <grounding_rules>
  Base approaches on the actual repository structure and patterns.
  Do not propose approaches that require frameworks or dependencies
  not present in the project.
  </grounding_rules>
  ```

- **Synthesis**: Merge option sets. New PEER-ONLY approaches → add.
  AGREED approaches → elevate confidence.

### Explore (investigate phase, analysis profile)

- **Purpose**: Independent architecture and integration analysis
- **Subcommand**: `task`
- **Prompt template**:

  ```xml
  <task>
  Analyze the codebase architecture relevant to this task.
  Identify: integration points, existing patterns to follow, potential
  conflict areas, and reusable components.
  Task: {task description}
  </task>

  <structured_output_contract>
  Return:
  1. Key files and modules involved
  2. Integration points with existing code
  3. Patterns to follow (with file references)
  4. Potential conflict or risk areas
  </structured_output_contract>

  <research_mode>
  Separate observed facts from inferences.
  Prefer breadth first, then depth where it changes the recommendation.
  </research_mode>

  <grounding_rules>
  Every claim must reference a specific file or code location.
  </grounding_rules>
  ```

- **Synthesis**: Merge structural findings. Local agents
  (architecture-mapper, flow-tracer) provide deep per-layer
  analysis; the peer provides a holistic cross-cutting view. Flag
  files/patterns found by only one side.

### Plan-verify (compose phase)

Applies to both `compose --profile=plan` (verifying a draft plan) and
`compose --profile=code` (verifying a freshly-written implementation).
The prompt below is for the plan profile; the code profile reuses the
same template but substitutes the draft plan with the diff or list of
written files.

- **Purpose**: Find gaps in the orchestrator's implementation plan
  (or in the freshly-written code, in `code` profile)
- **Subcommand**: `task`
- **Independence exception**: Receives the orchestrator's draft plan
  as input
- **Prompt template**:

  ```xml
  <task>
  Review this implementation plan for gaps, missing dependencies,
  ordering errors, underestimated complexity, and edge cases not
  addressed.

  Plan:
  {orchestrator's draft plan text}

  Original task:
  {user's task description}
  </task>

  <structured_output_contract>
  Return:
  1. Gaps: missing tasks or considerations
  2. Ordering issues: tasks that should come earlier/later
  3. Risk areas: tasks with underestimated complexity
  4. Edge cases: scenarios the plan does not handle
  </structured_output_contract>

  <dig_deeper_nudge>
  Check for second-order dependencies, rollback paths, and failure
  scenarios before finalizing.
  </dig_deeper_nudge>

  <completeness_contract>
  Do not stop at surface-level observations. Trace each task's
  dependencies fully.
  </completeness_contract>

  <grounding_rules>
  Ground every gap or issue in specific plan tasks or codebase evidence.
  </grounding_rules>
  ```

- **Synthesis**: Incorporate valid gaps. Note CONFLICT items.

### Review (critique phase, default profile)

- **Purpose**: Independent multi-perspective code review
- **Subcommand**: `task`
- **Prompt template**:

  ```xml
  <task>
  Review this code change set independently from a multi-perspective
  code review viewpoint. Identify defects, edge cases, type
  mismatches, missing tests, security issues, performance issues,
  and convention deviations.

  Change set (diff hunks + untracked file paths and contents):
  {orchestrator-collected change context}

  Repository: {repo context}
  </task>

  <structured_output_contract>
  Return findings as:
  - file:line — severity (CRITICAL|MAJOR|MINOR|SUGGESTION) — perspective — description
  Group by severity. Include "Looks Good" observations at the end.
  </structured_output_contract>

  <dig_deeper_nudge>
  Trace dependencies of changed code. Check error paths, concurrent
  access, backward compatibility, and integration with existing code.
  </dig_deeper_nudge>

  <grounding_rules>
  Every finding must reference specific file paths and line numbers
  from the change set. Label inferences explicitly.
  </grounding_rules>
  ```

- **Synthesis**: Merge findings by location. Same file + same issue →
  deduplicate, take higher severity. Unique findings → label source.

### Investigate (investigate phase, root-cause profile)

- **Purpose**: Independent root cause diagnosis
- **Subcommand**: `task`
- **Prompt template**:

  ```xml
  <task>
  Independently diagnose the root cause of this issue.
  Do not follow any pre-existing hypotheses — start from the symptoms
  and trace through the code.
  Symptom: {bug description}
  </task>

  <structured_output_contract>
  Return:
  1. Most likely root cause with evidence
  2. Confidence level (HIGH/MEDIUM/LOW)
  3. Alternative causes considered and why rejected
  4. Suggested verification step
  </structured_output_contract>

  <verification_loop>
  Before finalizing, verify that the proposed root cause explains all
  observed symptoms.
  </verification_loop>

  <missing_context_gating>
  If critical context is missing, state exactly what remains unknown
  rather than guessing.
  </missing_context_gating>

  <grounding_rules>
  Every claim must reference specific code locations.
  Label inferences explicitly.
  </grounding_rules>
  ```

- **Synthesis**: Cross-validate. AGREED → high confidence. PEER-ONLY →
  treat as additional hypothesis to verify with targeted check.
  CONFLICT → present both with evidence, ask user.

### Research-scan (investigate phase, cited-brief profile)

- **Purpose**: Independent topic-bound external research producing
  cited evidence per sub-question
- **Subcommand**: `task`
- **Canonical contract**:
  `skills/investigate/references/cited-brief-ensemble.md` (this entry
  exists for parallelism with Explore / Investigate; the full
  bidirectional protocol — privacy gate, citation remapping, Path A /
  Path B Independence Rule, dispatch via
  `plugins/engineer/scripts/dispatch-peer.mjs` — lives in the absorbed
  contract per [ADR-0014](../../../../../docs/adr/0014-plugins-research-deprecation.md))
- **Prompt template**:

  ```xml
  <task>
  Independently research this topic. Run web searches and gather
  primary-source evidence for each sub-question. Do not consult or
  reference any draft brief from the orchestrator.
  Topic: {confirmed topic}
  Sub-questions:
  {confirmed sub-questions list}
  Scope: {covered/excluded scope}
  </task>

  <structured_output_contract>
  Per sub-question, return:
  1. Findings synthesis with inline citations [N]
  2. Sources list — title, URL, access date, source type
     (official-docs | standards | academic | secondary)
  3. Open questions / gaps
  4. Confidence (HIGH/MEDIUM/LOW) with caveats
  </structured_output_contract>

  <citation_contract>
  Every substantive claim must trace to a [N]-cited source OR be
  marked as the model's own synthesis ([uncited inference]). Do not
  produce marketing claims without citations.
  </citation_contract>

  <privacy_contract>
  Use only the topic, sub-questions, and scope provided. Do NOT
  include host-side identifiers, file paths, or internal context that
  did not arrive via this prompt.
  </privacy_contract>

  <grounding_rules>
  Prefer Tier 1 sources (official-docs, standards, academic) over
  Tier 2 (vendor docs, recognized technical secondary) over Tier 3
  (community/anecdotal — fill gaps only).
  </grounding_rules>
  ```

- **Synthesis**: Apply the bidirectional Independence Rule — Path A
  locally verify and cite the PEER-ONLY claim, Path B move it to Open
  Questions. Citation numbering is remapped to local capture order;
  the peer's internal labels MUST NOT be copied verbatim. Source-of-
  discovery labels (`[Local]` / `[Peer]`) live in workflow phase
  notes only — the saved brief artifact strips them per
  `skills/investigate/references/cited-brief-spec.md` § Ensemble
  Label Policy.

### Refine-verify (refine phase)

- **Purpose**: Independent verification of an applied patch
- **Subcommand**: `task`
- **Prompt template**:

  ```xml
  <task>
  Review this applied patch independently to verify the fix is
  correct, doesn't introduce regressions, and addresses the root
  cause rather than the symptom.

  Patch (working-tree diff):
  {orchestrator-collected patch}

  Original issue:
  {bug description or feedback context}
  </task>

  <structured_output_contract>
  Return:
  1. Correctness assessment (does the patch address the stated issue?)
  2. Regression risks (what behavior may have changed unintentionally?)
  3. Test coverage (does this need additional tests?)
  4. New findings discovered while reviewing the patch
  </structured_output_contract>

  <verification_loop>
  Verify the patch by tracing the affected code paths end-to-end.
  Check edge cases and error paths.
  </verification_loop>

  <grounding_rules>
  Every claim must reference specific code locations in the patch.
  Label inferences explicitly.
  </grounding_rules>
  ```

- **Synthesis**: Same as Review type, scoped to the applied patch.

### Adversarial-scan (critique phase, full-codebase profile)

- **Purpose**: Adversarial parallel analysis when critique runs over
  an entire area (`/engineer:critique --profile=full-codebase`, or
  its optional sugar alias `/engineer:audit` per ADR-0010 §3
  verb-level alias policy)
- **Subcommand**: `task`
- **Focus text**: derived from critique sub-profile (security /
  performance / code-quality / debt / full); embedded in the prompt
  body's `<task>` block:
  - Security: `"authentication bypass, injection vectors, secret
    exposure, authorization boundary violations"`
  - Performance: `"N+1 queries, unnecessary allocation, missing
    indexes, blocking operations, memory leaks"`
  - Code quality: `"unnecessary complexity, dead code, inconsistent
    patterns, poor abstractions"`
  - Tech debt: `"TODO/FIXME accumulation, deprecated API usage, test
    coverage gaps, maintenance burden"`
  - Full: `"design flaws, architectural weaknesses, hidden
    assumptions, failure modes"`
- **Prompt template**:

  ```xml
  <task>
  Conduct an adversarial review of the specified area, looking for
  hidden assumptions, design flaws, architectural weaknesses, and
  failure modes that single-perspective review may miss.

  Focus: {focus text from sub-profile above}

  Area (file list + code excerpts):
  {orchestrator-collected scope context}
  </task>

  <structured_output_contract>
  Return findings as:
  - file:line — severity (CRITICAL|MAJOR|MINOR|SUGGESTION) — perspective: adversarial-scan — description
  Group by severity. Include "Looks Good" observations at the end.
  For each finding, state the specific failure scenario (what
  triggers the issue, what breaks).
  </structured_output_contract>

  <dig_deeper_nudge>
  Trace second-order effects. What relies on the assumption being
  questioned? What would break if the assumption fails?
  </dig_deeper_nudge>

  <adversarial_mindset>
  Adopt the perspective of an attacker, an external integrator, or a
  future maintainer with no prior context. What could go wrong? What
  is being assumed silently? Where is the design fragile under
  evolution?
  </adversarial_mindset>

  <grounding_rules>
  Every finding must reference specific file paths and line numbers.
  Label inferences explicitly.
  </grounding_rules>
  ```

- **Synthesis**: Merge with orchestrator findings. Deduplicate by
  location. Source-label all findings.

---

## Failure Handling

### Peer unavailable, not installed, or unauthenticated

- **Detect**: companion discovery returns empty (the `companions`
  plugin is not installed), or the peer companion exits with an
  auth error.
- **Action**: Skip the dispatch, log a stderr warning. Proceed with
  orchestrator-only results.
- **Present**: "Peer ensemble unavailable — results are
  orchestrator-only. Install the `companions` plugin and ensure the
  peer host CLI is authenticated."

### Peer timeout or error

- **Detect**: background task returns error or empty output.
- **Action**: Log error, proceed with orchestrator-only results.
- **Present**: "Peer analysis did not complete — results are
  orchestrator-only for this phase."

### Peer returns malformed or incomplete output

- **Detect**: Output does not match the expected structure, or is
  structurally valid but missing expected sections (e.g., only 2 of
  4 required fields present).
- **Action**: Include available output in the synthesis attempt.
  For missing sections, record them as "Peer: not analyzed".
- **Present**: "Peer output was partially parsed — some findings
  may be missing." List which sections were present and which were
  absent.

### Large change set / large area

- **Detect**: For Review type, `git diff <base>...HEAD | wc -l`
  exceeds ~1500 lines. For Adversarial-scan, the scoped file list
  exceeds ~1500 LOC of cumulative content. Or the peer task has not
  produced output for >10 minutes after launch on a known large
  scope.
- **Action**: Slice the change set / area into segments under ~800
  lines each. Issue one peer `task` invocation per segment with the
  segment's hunks/contents in `<task>`. Aggregate findings across
  segments at synthesis time, deduplicating shared concerns.
- **Present**: "Diff/area exceeds slicing threshold — peer review
  issued in K segments."

### Graceful degradation principle

Ensemble failure must never block the workflow. Orchestrator-only
results are always sufficient to proceed. The peer adds value when
available but is not required.
