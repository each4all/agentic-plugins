# Ensemble Protocol

Defines how Claude and Codex operate as a dual-model **bidirectional**
ensemble within the engineer plugin. Either host can be the
**orchestrator** (the host where the user is currently invoking the
skill); the other is the **peer**. The orchestrator drives the
workflow, dispatches the peer for independent parallel analysis, and
synthesizes both perspectives into a unified result.

The Stage 1 `plugins/research` plugin established this bidirectional
pattern empirically before its retirement at Stage 2.5+ (per
[ADR-0014](../../../../../../docs/adr/0014-plugins-research-deprecation.md)
Amendment 2026-05-06): when invoked on Claude Code, it called
`codex-companion`; when invoked on Codex CLI, it called
`claude-companion`. The engineer plugin adopts the same symmetry
across all six verbs and absorbs the cited-brief contract that drove
the original pattern.

---

## Always-max policy

Every phase boundary in `/engineer:*` commands automatically
dispatches the peer ensemble. **There is no `LOW` skip.** Engineer's
user value is maximum-quality output; the peer call is paid at every
phase boundary regardless of the `Ensemble Affinity` rating recorded in
the Task Profile (`./orchestration.md` Step 1), which informs the
orchestrator's local agent count instead.

<!-- pipeline:begin ensemble-always-max -->
The peer call uses the host's configured model with maximum
effort/depth. Skills do **not** pass `--model` or `--effort` flags —
each host's config file (`~/.codex/config.toml`,
`~/.claude/settings.json`, etc.) is the single source of truth.

`Ensemble Affinity` (LOW / MEDIUM / HIGH) is retained as a Task Profile
axis (records context about the task) but does **not** gate dispatch.
<!-- pipeline:end ensemble-always-max -->

---

## Bidirectional invocation pattern

<!-- pipeline:begin ensemble-bidirectional -->
Direction is symmetric:

| Orchestrator | Peer        | Peer invocation                                                |
|--------------|-------------|----------------------------------------------------------------|
| Claude Code  | Codex CLI   | `codex-companion` (resolved via `companions` plugin discovery) |
| Codex CLI    | Claude Code | `claude-companion` (resolved via `companions` plugin discovery)|

Both companion CLIs ship in the agentic-plugins `companions` plugin and
implement `companions/contract.md` v0.1.1. The contract exposes a single
subcommand `task --prompt-file <path>` accepting an XML prompt. engineer
expresses every ensemble point type as a `task` invocation with a
type-specific prompt template; review-style ensembles embed the review
semantics in the prompt itself rather than relying on separate
subcommands.

The orchestrator is the currently-invoking host; the peer is the other
host. Skills never hard-code one side or the other — they refer to
*orchestrator* and *peer*. Discovery + dispatch mechanics live in
`../../../../scripts/peer-runner.mjs` (the managed runner for
command-runbook ensembles), with `../../../../scripts/dispatch-peer.mjs`
retained as the blocking compatibility surface. On discovery failure the
dispatch is skipped silently per *Failure Handling* below.
<!-- pipeline:end ensemble-bidirectional -->

---

## When This Protocol Applies

<!-- pipeline:begin ensemble-when-applies -->
Activates automatically at every command-defined phase boundary in
`/engineer:*` commands. Each command file specifies which phase invokes
which ensemble point type (see *Ensemble Point Types* below).

- Claude: `/engineer:<verb> …` (slash command)
- Codex: `$engineer:<verb> …` (skill mention; per ADR-0021
  cognitive-runbook parity, full slash-command parity is deferred to
  ADR-0013 reserved)

Does NOT apply to:
- Skills auto-activated outside any `/engineer:*` command (auto-activated
  mode runs without ensemble dispatch — the lightweight in-context path).
- The three meta skills (`checkpoint` / `resume` / `peer-now`). `peer-now`
  dispatches the companion, but as a **side-channel**, not an ensemble —
  see *State Bookkeeping* below.
- The commit command (`/engineer:commit`), which commits a verb chain's
  change or closes its workflow and dispatches no peer.
- Binary confirmations or progress updates within the same session.
- Internal orchestration decisions.
<!-- pipeline:end ensemble-when-applies -->

---

## Execution Pattern

<!-- pipeline:begin ensemble-execution-intro -->
Every ensemble point follows three steps: **Launch**, **Collect**,
**Synthesize**.
<!-- pipeline:end ensemble-execution-intro -->

### Step 1: Launch

<!-- pipeline:begin ensemble-launch -->
1. Determine the ensemble point type (see *Ensemble Point Types* below).
2. Resolve the peer companion via the companion-cache discovery
   (`AGENTIC_COMPANIONS_ROOT` env override honored, per ADR-0008). If
   discovery fails, the ensemble degrades to local-only.
3. Construct the peer prompt per the type-specific template (see *Prompt
   Construction Rules*). Write it to a per-dispatch UTF-8 tempfile and
   pass it via `--prompt-file <path>` per `companions/contract.md` §2.2 —
   never as a positional argument and never inlined into a shell command,
   so the prompt never crosses shell parsing, process argv, or `ps aux`.
4. Invoke the companion in **JSON envelope mode** through
   `../../../../scripts/peer-runner.mjs run`, which records the matching
   `pending_ensemble` row and writes raw stdout/stderr plus the parsed
   envelope under the hidden peer-run ledger. The orchestrator SHOULD
   background the call (Bash `run_in_background` on Claude; the `task`
   subcommand on Codex) so its own analysis proceeds in parallel. The
   runner runs in the foreground of that background task, never behind a
   shell `&`, which would detach it where the host can neither track it
   nor notify you when it exits.
5. The orchestrator proceeds immediately to its own parallel analysis.
<!-- pipeline:end ensemble-launch -->

### Step 2: Collect

<!-- pipeline:begin ensemble-collect -->
1. Wait for the background dispatch notification — do NOT poll, sleep,
   or proactively check status.

   **Autopilot (ADR-0063, Claude only):** the driver's stream-json host
   keeps the session alive while a background task is pending and
   re-invokes the model when it completes, so wait for the notification
   exactly as written; never sleep-poll a file (`autopilot-mode.md` § Peer
   ensembles). The step report the host takes when you end a turn to wait
   is provisional: on the notification, finish Synthesize, settle the
   attempt (Phase 2's `peer-runner.mjs settle`) and make the verb's last
   write, then report again.

2. Read the peer-runner JSON first. Its `status` (`completed`, `failed`
   or `cancelled`), `error_kind` and `envelope_path` describe the run,
   not the peer's answer. When `envelope_path` is null there is no
   envelope to read, and the run degrades to local-only: `error_kind`
   says why — `peer_cli_not_found` (no companion resolved),
   `envelope_parse_error` (the companion's stdout was not JSON), or a
   spawn, signal or cancel kind. Diagnose it from `stdout_path` /
   `stderr_path`.
3. Otherwise read `envelope_path` for the parsed companion envelope. Its
   keys are pinned by `companions/contract.md` §4.2:
   `{status, peer_host, peer_model, stdout, exit_code, [error, metadata]}`;
   an envelope the runner marked `error_kind: envelope_shape_invalid`
   breaks that contract (a missing or mistyped key, or a `status` that
   disagrees with its `exit_code` or `error`) and is malformed, with no
   answer to parse. Classify by the envelope's
   `status`: `success` → parse the peer answer;
   `peer_error` (`error.kind: peer_run_error`) → peer malformed/empty;
   `companion_error` with `error.kind ∈ {peer_cli_not_found,
   peer_unauthenticated, peer_invocation_error}` → degrade to local-only;
   `companion_error` with `error.kind: companion_misuse` → adapter bug,
   surface as a runtime error (not a degradation case).
4. If the peer failed or returned empty output, proceed to Synthesize
   with orchestrator-only results (graceful degradation, see *Failure
   Handling*). Either way the finalize settles the attempt from its run
   ledger (`peer-runner.mjs settle`), which records what the ledger shows:
   verdict `failed` with its `error_kind`, `degraded` for a completed run
   with no usable answer, or the synthesis verdict. The ledger shows an
   empty or unreadable answer; for one that parses to nothing usable, only
   structural shell, the synthesis verdict is `degraded`.
<!-- pipeline:end ensemble-collect -->

### Step 3: Synthesize

<!-- pipeline:begin ensemble-synthesize-intro -->
Classify every finding, recommendation, direction, or conclusion from
both sources into one of four base synthesis categories.
<!-- pipeline:end ensemble-synthesize-intro -->

#### Base Synthesis Categories

<!-- pipeline:begin ensemble-categories -->
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
<!-- pipeline:end ensemble-categories -->

Synthesis output replaces the standard single-model output. Follow
the Presentation Mode Protocol (`presentation-protocol.md`) for the
synthesized result.

### State Bookkeeping

<!-- pipeline:begin ensemble-bookkeeping -->
Ensemble dispatch and synthesis are recorded in **two complementary
locations**, both through engineer's `../../../../scripts/state.mjs`:

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

**Each attempt is settled from its run ledger.** A verb's finalize runs
`../../../../scripts/peer-runner.mjs settle` with the run id its dispatch
generated (empty when no run launched) before its last write, and the
ledger, not the agent, decides what the workflow records:

- never launched (the verb ran local-only, so no dispatch ran):
  nothing, and the phase note's first heading reads
  `### Ensemble skipped: …`;
- launched, then failed, cancelled or abandoned: an `ensemble_results`
  entry with verdict `failed` and the ledger's `error_kind` in its summary;
- completed: the synthesis verdict, or `degraded` when the answer was empty
  or unreadable (the synthesis is then local-only). An answer that parses to
  nothing usable, only structural shell, reads to `settle` like any other:
  the synthesis judges it, and its verdict is then `degraded`.

`settle` refuses while the run is still live (collect it first), and when an
empty run id would hide a run that launched for the same workflow and phase.

**`peer-now` is structurally excluded** from `ensemble_results`, by two
independent mechanisms:

1. `../../../../scripts/peer-runner.mjs` registers a `pending_ensemble` row
   only when `kind === 'ensemble'` — the `handle.kind !== 'ensemble'`
   early return. A `--kind peer-now` run cannot reach that write path.
2. The `peer-now` meta skill omits the three ensemble-accounting flags:
   `--workflow-path` / `--phase` / `--ensemble-type`. It **does** pass
   `--run-id`, which is the peer-run **ledger** key (it names the
   `peer-runs/<run_id>/` directory and lets `peer-runner.mjs status` /
   `cancel` address the run), not an ensemble key. Passing it is correct
   and does not create an ensemble record.

`ensemble_results` stays reserved for verb-skill structured ensemble
verdicts. A `[Peer]` label phase note in the workflow body is peer-now's
only trace in the workflow; the run's own ledger under
`peer-runs/<run_id>/` keeps its handle and logs.
<!-- pipeline:end ensemble-bookkeeping -->

---

## Prompt Construction Rules

<!-- pipeline:begin ensemble-prompt-intro -->
All peer prompts are XML block structures passed to the companions `task`
subcommand via `--prompt-file <path>`. The orchestrator materializes the
prompt to a tempfile to keep it out of `ps aux` and avoid the `ARG_MAX`
ceiling.
<!-- pipeline:end ensemble-prompt-intro -->

### Required blocks for every ensemble prompt

- `<task>`: Concrete job description with repository context
- `<structured_output_contract>`: Exact output shape
- `<grounding_rules>`: Ground claims in code/evidence; label
  inferences

### Additional blocks by ensemble point type

- **Explore** (investigate phase, analysis profile): add `<research_mode>`
- **Investigate** (root-cause profile): add `<verification_loop>`,
  `<missing_context_gating>`
- **Brainstorm** (decide phase): optional `<axis_awareness>` per
  ADR-0027 §4.2. Present only when both §4.3 conditions hold:
  `context.registry_fallback === false` AND command mode (the
  Claude `/engineer:decide` command file is the canonical emit
  site; Codex skill-mention follows ADR-0001 §5 honest scope).
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
  `core/skills/investigate/references/cited-brief-ensemble.md` §
  Prompt Construction)

### Do not pass --model or --effort

Each host's config file is the single source of truth for model,
effort, and service tier. Passing these flags would override the
user's global configuration.

---

## Independence Rule

<!-- pipeline:begin ensemble-independence -->
The peer must analyze independently. Do not include the orchestrator's
in-progress findings, hypotheses, draft conclusions, confidence ratings,
or intermediate results in the peer prompt.
<!-- pipeline:end ensemble-independence -->

Both hosts receive the same raw context:

- Source code (via the host's own file access)
- Git state (via the host's own git access)
- The user's original request or task description

**Single exception**: Plan-verify ensemble. The peer receives the
orchestrator's draft plan as explicit input, because the task is to
find gaps in that specific plan.

<!-- pipeline:begin ensemble-independence-bidirectional -->
The Independence Rule is explicitly **bidirectional**: when the local
host is Claude, Claude does not leak its findings into the
`codex-companion` prompt; when the local host is Codex, Codex does not
leak its findings into the `claude-companion` prompt.
<!-- pipeline:end ensemble-independence-bidirectional -->

---

## Ensemble Point Types

<!-- pipeline:begin ensemble-point-types-intro -->
Each `/engineer:<verb>` command's phases dispatch one or more of these
point types. The verb→type mapping is in each command's body. All types
use the companions `task --prompt-file <path>` subcommand per the
Bidirectional invocation pattern above.
<!-- pipeline:end ensemble-point-types-intro -->

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

  <axis_awareness>
  Preset: {preset-id resolved per ADR-0027 §1.5}
  Size: {minor | standard | major}
  Axes:
    - id: <axis-id>; label: <en-label>; question: <core question>; role: <decisive | supporting>
    - ...
  Weights: {comma-separated id:weight | "uniform"}
  </axis_awareness>

  <structured_output_contract>
  For each approach:
  1. Name and one-sentence summary
  2. Key tradeoffs (pros and cons) — when <axis_awareness> is present,
     express each tradeoff against the named axes' labels and roles
  3. Risk areas
  4. Estimated scope (files/layers affected)
  </structured_output_contract>

  <grounding_rules>
  Base approaches on the actual repository structure and patterns.
  Do not propose approaches that require frameworks or dependencies
  not present in the project.
  </grounding_rules>
  ```

- **Presence rule (ADR-0027 §4.3)**: The `<axis_awareness>` block is
  emitted in the prompt only when **both** conditions hold:

  1. The orchestrator successfully resolved a preset — i.e.,
     `context.registry_fallback === false` on the resolved
     ResolvedDecisionContext printed by `decide-registry.mjs resolve` (per ADR-0027 §5.6 PR5
     amendment; the field disambiguates `preset_id: "default"` because
     no flag was passed from `preset_id: "default"` because a §1.6
     fallback path fired).
  2. The orchestrator is in **command mode** (`/engineer:decide` or
     `$engineer:decide` slash invocation). Auto-activated /
     standalone-skill mode does NOT have a registry-resolved preset
     and the block is omitted unconditionally — strict-grammar
     argument parsing is a command-mode contract per ADR-0027 §2.6.

  When either condition fails, the block is omitted entirely. The
  peer falls back to free-form 2-3 approaches per the original
  axis-agnostic shape — graceful degradation per the §Failure
  Handling rules below. The `commands/decide.md` Phase 1 prompt
  builder is the single emit point; auto-activated mode never
  reaches a peer-runner dispatch (per SKILL.md "## When
  auto-activated" — "no peer ensemble dispatch"), closing the
  E4 guardrail at the call-site rather than the template.

- **Snapshot rule (ADR-0027 §4.3)**: When `<axis_awareness>` is
  present, the orchestrator captures the corresponding subset of
  ResolvedDecisionContext — `{preset_id, axes, size, weights}` — in
  memory before dispatching the peer. Synthesis consumes this
  in-memory snapshot, NOT a re-read of `decision-axes.yml`. If the
  registry file changes mid-dispatch, or the CLI environment
  changes between dispatch and synthesis, the snapshot
  authoritatively describes the axis frame both sides shared. The
  snapshot is **in-memory for the duration of the command**; it
  does NOT need to persist to disk across sessions (the resolver
  prints the context in Phase 0.5, and the session holds it for the
  rest of the command; nothing is written to disk).
  Cross-session resume after host exit cannot reconstruct the
  exact original snapshot — that case re-runs preset resolution
  against the current registry, and any drift surfaces through
  the registry's §1.6 graceful-degradation diagnostics.

- **Weights serialization convention**: the `Weights:` line uses the
  word `uniform` when `context.weights === {}` (the empty-sentinel
  from PR4 normalization). When `context.weights_explicit === true`,
  the line is rendered as comma-separated `axis-id:weight` pairs in
  **document order** (ADR-0027 §1.4 axis-ordering invariant), e.g.
  `Weights: essence:2,foundation:2,practical-fit:1`. Unknown axes
  passed by the user (`--weights=ghost:2`) are NOT emitted — the
  PR4 normalizer drops them at parse time and surfaces a stderr
  diagnostic; the snapshot's `weights` map only contains axes
  that exist in the resolved preset's axes list.

- **Synthesis**: Merge option sets per the AGREED / LOCAL-ONLY /
  PEER-ONLY / CONFLICT base categories defined in §Step 3. When
  `<axis_awareness>` was present at dispatch (per the presence
  rule above), additionally evaluate each PEER-ONLY approach
  against the snapshotted axis set per ADR-0027 §4.4:

  1. Tag the approach `[Peer · unmapped]` (extending the standard
     `[Peer]` label) when its tradeoff vocabulary uses concepts
     orthogonal to the snapshot's axes — for example, the peer
     proposed an approach justified by "operator cognitive load"
     when the snapshot's preset is `default` (5-axis) and that
     concept does not map cleanly to any of essence / foundation /
     standards / best-practice / practical-fit.
  2. Attempt local axis assessment — the orchestrator looks at the
     peer's approach and rates it against the snapshot's axes from
     its own analysis before merging.
  3. If local mapping fails (the approach is genuinely outside the
     axis frame), present as PEER-ONLY with reduced confidence and
     surface the unmapped-vocabulary list to the user. The user MAY
     then choose to widen the preset (re-invoke with
     `--preset=nine-axis`, for example) or accept the unmapped
     approach as a frame-incompatibility signal.

  This is a quality refinement on top of the base categorization —
  AGREED / LOCAL-ONLY / PEER-ONLY / CONFLICT remain the four base
  buckets; `[Peer · unmapped]` is a presentation sub-label, not a
  fifth category. New PEER-ONLY approaches still get added;
  AGREED approaches still get confidence elevated.

- **XML escaping** (ADR-0027 §1.1 PR5 amendment, editorial rule):
  axis labels and questions are free-text YAML fields. Registry
  authors MUST keep them free of the XML predefined entities
  (`&`, `<`, `>`, `"`, `'`) since the `<axis_awareness>` block
  emitter (the LLM prompt-builder in `commands/decide.md` Phase 1)
  does NOT escape on emission. All presets shipped in PR2
  (`default`, `compact`, `nine-axis`) are escape-free; future
  presets must follow the same constraint.

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
  `core/skills/investigate/references/cited-brief-ensemble.md` (this entry
  exists for parallelism with Explore / Investigate; the full
  bidirectional protocol — privacy gate, citation remapping, Path A /
  Path B Independence Rule, dispatch via
  `plugins/engineer/scripts/peer-runner.mjs` — lives in the absorbed
  contract per [ADR-0014](../../../../../../docs/adr/0014-plugins-research-deprecation.md))
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
  `core/skills/investigate/references/cited-brief-spec.md` § Ensemble
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

<!-- pipeline:begin ensemble-failure-unavailable -->
- **Detect**: companion discovery returns empty (the `companions` plugin
  is not installed), or `error.kind ∈ {peer_cli_not_found,
  peer_unauthenticated, peer_invocation_error}`.
- **Action**: Proceed with orchestrator-only analysis, silently. A run the
  runner started settles as verdict `failed` with this `error_kind`
  (`peer-runner.mjs settle`); with no run launched there is nothing to
  settle.
- **Surface**: Mention in the user-facing completion summary that the
  ensemble was unavailable. Do NOT label findings inside the saved
  artifact.
<!-- pipeline:end ensemble-failure-unavailable -->

### Peer timeout or runtime error

<!-- pipeline:begin ensemble-failure-error -->
- **Detect**: `status: peer_error` with `error.kind: peer_run_error`, or
  the background dispatch exits unmappably.
- **Action**: Proceed orchestrator-only; settling the attempt records
  verdict `failed` with the ledger's `error_kind`.
- **Surface**: Same as above.
<!-- pipeline:end ensemble-failure-error -->

### Peer returns empty or malformed output

<!-- pipeline:begin ensemble-failure-empty -->
- **Detect**: Envelope `status: success` but `stdout` parses to no
  findings, or is structurally valid but missing required fields for some
  findings.
- **Action**: Parse only the findings that pass structural validation;
  discard the rest. Continue with the salvageable subset. A completed run
  with no usable answer at all settles as verdict `degraded`. `settle` sees
  an empty or unreadable answer itself; an answer that parses to no
  findings, only structural shell, reads to it like any other, so pass
  `degraded` as the synthesis verdict then.
- **Surface**: Mention in the completion summary that ensemble coverage
  was partial, and which sections the peer did not cover.
<!-- pipeline:end ensemble-failure-empty -->

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

<!-- pipeline:begin ensemble-graceful -->
Ensemble failure must never block the workflow. Orchestrator-only results
are always sufficient to proceed: on the local-only path the verb still
assembles its brief, deliverable or critique report, and saves it
where it saves one. The peer adds value when available but is not
required, and a saved artifact never reveals whether the ensemble ran.
<!-- pipeline:end ensemble-graceful -->
