# Ensemble Protocol (designer persona)

Defines how the local host and a peer host operate as a dual-model
**bidirectional** ensemble within the designer plugin. Either host can be
the **orchestrator** (the host where the user is currently invoking the
skill); the other is the **peer**. The orchestrator drives the workflow,
dispatches the peer for independent parallel analysis, and synthesizes
both perspectives into a unified design result.

**Plugin boundary note**: this is designer's **own copy** of the ensemble
protocol (lives at `plugins/designer/skills/_shared/references/`). Per
ADR-0010 §5 cross-plugin imports are forbidden — designer ships its own
copy rather than importing engineer's or founder's (ADR-0029 §Neutral
copy/adapt rule; the fourth copy per ADR-0042 SD7). The **mechanics**
(Launch / Collect / Synthesize, the AGREED / LOCAL-ONLY / PEER-ONLY /
CONFLICT vocabulary, graceful degradation) are the shared shape; the
**point templates** below are re-anchored from business concerns to
design concerns (flows, patterns, heuristics, accessibility, conversion,
design-system conformance) per ADR-0042 SD6. If the protocol proves
universal across L3 personas, an L1/L2 extraction may be considered
through a fresh ADR; this file does NOT serve cross-persona imports
as-is.

The six point types below are the design analogue of the engineer /
founder ensemble point sets. The **reference-scan** point has its full
bidirectional contract in
`../../investigate/references/design-brief-ensemble.md` (landed at
ADR-0042 PR3); this file cross-references it rather than duplicating the
citation-remapping / Path-A / Path-B machinery.

---

## The peer never sees an image (ADR-0042 SD4 item 3)

This is designer's load-bearing asymmetry, and it constrains **every**
point template below.

Both hosts accept image input directly — Claude natively, Codex CLI via
`codex exec --image <file>` — so a screenshot critique run **on the
active host** is cross-host symmetric. The **companion peer path is
not**: `codex-companion.mjs` exposes no `--image` flag. Therefore:

- Vision-grounded judgment is a **same-host** capability. The peer adds
  a code/text perspective, never a visual one.
- A peer prompt **never** carries inline image bytes. When a screenshot
  is genuinely load-bearing for the peer's reasoning, pass a
  **verified-local absolute file path** the peer reads on its own host
  (the `plugins/image` critique-dispatch precedent) — and only after the
  privacy gate clears it. Never base64, never an attachment.
- No `peer-runner.mjs run` invocation in any `/designer:*` command passes
  `--image`. A dispatch that does is a defect.

Honest scope: when the ensemble is the only reader of a rendered screen,
the visual dimension of that pass is **UNVERIFIED**, not merely
peer-degraded.

---

## Always-max policy

Every phase boundary in `/designer:*` commands automatically dispatches
the peer ensemble. **There is no `LOW` skip.** designer's user value is
maximum-quality design decision support and quality assurance; the peer
call is paid at every phase boundary regardless of the `Ensemble
Affinity` rating recorded in the Design Task Profile
(`./orchestration.md` Step 1).

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
subcommand `task --prompt-file <path>` accepting an XML prompt. designer
expresses every ensemble point type as a `task` invocation with a
type-specific prompt template; review-style ensembles (review,
refine-verify) embed the review semantics in the prompt itself rather
than relying on separate subcommands.

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
`/designer:*` commands. Each command file specifies which phase invokes
which ensemble point type (see *Ensemble Point Types* below).

- Claude: `/designer:<verb> …` (slash command)
- Codex: `$designer:<verb> …` (skill mention; per ADR-0042 SD1 /
  ADR-0021 cognitive-runbook parity, full slash-command parity is
  deferred to ADR-0013 reserved)

Does NOT apply to:
- Skills auto-activated outside any `/designer:*` command (auto-activated
  mode runs without ensemble dispatch — the lightweight in-context path).
- The three meta skills (`checkpoint` / `resume` / `peer-now`). `peer-now`
  dispatches the companion, but as a **side-channel**, not an ensemble —
  see *State Bookkeeping* below.
- Binary confirmations or progress updates within the same session.
- Internal orchestration decisions.

---

## Execution Pattern

Every ensemble point follows three steps: **Launch**, **Collect**,
**Synthesize**.

### Step 1: Launch

1. Determine the ensemble point type (see *Ensemble Point Types* below).
2. **Pass the privacy gate** (see *Privacy* below) for the topic AND
   everything that will travel in the peer prompt. Proprietary UI,
   unreleased features/flows, customer data visible in screenshots, and
   secret-bearing frontend code pass an explicit privacy gate before
   BOTH web search AND peer-host dispatch. Genericize before
   constructing the prompt. **Screenshots are sensitive by default.**
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
6. The orchestrator proceeds immediately to its own parallel analysis —
   including any host-direct vision read, which the peer cannot perform.

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

Classify every finding, direction, or conclusion from both sources into
one of four base synthesis categories.

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

**Vision asymmetry rule.** A finding that only a host-direct vision read
could produce (contrast, visible focus styling, spacing, visual
hierarchy on the rendered screen) is `LOCAL-ONLY` **by construction** —
the peer never saw the screen. Do NOT read the peer's silence on such a
finding as disagreement, and do NOT elevate a code/text-only peer
agreement into visual confirmation.

**Artifact label policy.** These source-of-discovery labels live in
**workflow phase notes** for orchestration transparency. They are
**stripped from saved design artifacts** — a saved design brief, flow
spec, wireframe spec, or critique report carries no `[Local]` /
`[Peer]` / `[Both]` marker, per the Ensemble Label Policy in
`../../investigate/references/design-brief-spec.md`. A reader of the
artifact should not be able to tell whether the ensemble ran at all.

### State Bookkeeping

Ensemble dispatch and synthesis are recorded in **two complementary
locations**, both through designer's `../../../scripts/state.mjs`:

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

**`peer-now` is structurally excluded** from `ensemble_results`, by two
independent mechanisms:

1. `../../../scripts/peer-runner.mjs` registers a `pending_ensemble` row
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
only durable trace.

**Do not record an ensemble that never ran.** When the privacy gate
forces local-only, or the companion is unavailable, skip
`ensemble-commit` entirely and record `### Ensemble degraded:` or
`### Ensemble skipped (local-only, privacy):` in the body instead.

---

## Prompt Construction Rules

All peer prompts are XML block structures passed to the companions `task`
subcommand via `--prompt-file <path>`. The orchestrator materializes the
prompt to a tempfile to keep it out of `ps aux` and avoid the `ARG_MAX`
ceiling.

### Required blocks for every ensemble prompt

- `<task>`: Concrete design job description with genericized context
- `<structured_output_contract>`: Exact output shape
- `<grounding_rules>`: Ground claims in evidence; label inferences
  `INFERENCE:`; vendor/marketing design claims need corroboration

### Additional blocks by ensemble point type

- **Frame** (frame phase): `<privacy_contract>`
- **Brainstorm** (decide phase): optional `<axis_awareness>` — present
  only when the orchestrator resolved a design preset
  (`registry_fallback === false`) AND is in command mode (see §Brainstorm
  presence rule); plus `<privacy_contract>`
- **Plan-verify** (compose phase): add `<dig_deeper_nudge>`,
  `<completeness_contract>`, `<privacy_contract>`
- **Review** (critique phase): add `<dig_deeper_nudge>`,
  `<vision_boundary>`, `<privacy_contract>`
- **Refine-verify** (refine phase): add `<verification_loop>`,
  `<vision_boundary>`, `<privacy_contract>`
- **Reference-scan** (investigate design-brief profile): add
  `<citation_contract>`, `<privacy_contract>` (full prompt construction
  in `../../investigate/references/design-brief-ensemble.md` §Prompt
  Construction)

Every designer ensemble prompt carries a `<privacy_contract>` block —
external transmission to the peer host is treated with the same
discipline as web search (see *Privacy* below). This is the load-bearing
difference from the engineer protocol, where most points omit it.

The `<vision_boundary>` block is designer-specific. It tells the peer
plainly that it has **not** seen the rendered screen, so it neither
fabricates visual observations nor asserts that a visual concern is
absent:

```xml
<vision_boundary>
You have NOT seen the rendered screen — only code and text. Do not assert
visual properties (contrast ratios, spacing, visual hierarchy, focus-ring
appearance) as observed fact. Where a concern requires seeing the screen,
name it as a question for the vision-capable reviewer instead of a
finding. Structural evidence in the code (a missing label, a div-as-button,
a hard-coded color pair) IS observable to you — report those normally.
</vision_boundary>
```

### Do not pass --model, --effort, or --image

Each host's config file is the single source of truth for model, effort,
and service tier. Passing the first two would override the user's global
configuration. `--image` does not exist on the companion path at all
(see *The peer never sees an image* above).

---

## Independence Rule

The peer must analyze independently. Do not include the orchestrator's
in-progress findings, hypotheses, draft conclusions, confidence ratings,
or intermediate results in the peer prompt.

Both hosts receive the same raw context: the genericized surface /
directions / artifact, the platform and viewport constraints in scope,
and the user's original design request.

**Single exception**: the **Plan-verify** ensemble. The peer receives the
orchestrator's genericized draft spec as explicit input, because the task
is to find gaps in that specific spec. The exception is scoped to the
spec text — the orchestrator's *judgments about* the spec are still
withheld. (Review and Refine-verify likewise pass the artifact under
review; that artifact is the raw object of the task, not an orchestrator
judgment.)

The Independence Rule is explicitly **bidirectional**: when the local
host is Claude, Claude does not leak its findings into the
`codex-companion` prompt; when the local host is Codex, Codex does not
leak its findings into the `claude-companion` prompt.

---

## Privacy

designer's privacy gate covers external **peer-host dispatch** in
addition to web search. Specifically: proprietary UI, unreleased
features/flows, customer data visible in screenshots, and secret-bearing
frontend code **pass an explicit privacy gate before BOTH web search AND
peer-host dispatch** — the gate is checked once and governs every
external transmission in the phase.

- Everything transmitted in the peer prompt (surface description,
  directions, sub-questions, draft spec, artifact under review, code
  excerpts) is treated as external transmission. Apply the same
  genericization rules as WebSearch — no unreleased feature or flow
  names, no customer identifiers, no internal product names, no secrets,
  tokens, or endpoint URLs pasted from frontend code.
- **Screenshots are sensitive by default.** A raw screenshot of a real UI
  never leaves the local host as bytes. When a screenshot must inform the
  peer, describe it in genericized terms, or pass a verified-local
  absolute file path only after the user clears it.
- The `<privacy_contract>` block in every prompt instructs the peer to
  refrain from fabricating or echoing proprietary identifiers and from
  de-anonymizing a genericized surface to a specific named product.
- If the genericization substitution is generic (e.g., "a two-step mobile
  checkout flow"), pass the substituted form to the peer too — never the
  original pre-genericization value.

The privacy gate is **bidirectional** — the same discipline applies
whether the local host is Claude (sending to Codex) or Codex (sending to
Claude). **The pre-genericization value MUST never leave the local
host.** When the user declines genericization or aborts the session, do
NOT dispatch to the peer. See
`../../investigate/references/design-brief-spec.md` § Privacy Gate for
the canonical rule.

---

## Ensemble Point Types

Each `/designer:<verb>` command's phases dispatch one of these point
types. The verb→type mapping is in each command's body. All types use the
companions `task --prompt-file <path>` subcommand per the Bidirectional
invocation pattern above.

| Verb | `--ensemble-type` | Point type |
|---|---|---|
| `investigate` (`design-brief`) | `reference-scan` | Reference-scan |
| `frame` | `frame` | Frame |
| `decide` | `brainstorm` | Brainstorm |
| `compose` | `plan-verify` | Plan-verify |
| `critique` | `review` | Review |
| `refine` | `refine-verify` | Refine-verify |

### Frame (frame phase)

- **Purpose**: Independent UX problem-model framing
- **Subcommand**: `task`
- **Prompt template**:

  ```xml
  <task>
  Given this genericized design evidence, independently build a UX problem
  model: user problem, primary user + job-to-be-done, goals, MEASURABLE UX
  success metrics, constraints, key risks, and explicit out-of-scope items.
  Do not see the local host's model — produce a fresh, independent one.
  Evidence: {genericized investigate findings or user-supplied context}
  Surface / Platform: {surface in scope; platform, viewport class, LTR/RTL}
  </task>

  <structured_output_contract>
  Return one UX problem model:
  1. User problem (1-2 sentences)
  2. Primary user + job-to-be-done
  3. Goals (what a good outcome looks like for the user AND the product)
  4. Measurable UX success metrics (task-completion, time-on-task,
     error-rate, drop-off at a named step — each with how it is observed)
  5. Constraints (platform / design-system / accessibility / frontend-stack
     / effort / content)
  6. Key risks (usability / accessibility / conversion / consistency /
     feasibility) + an early-detection signal each
  7. Out of scope
  Mark uncertain fields [to be validated] rather than guessing.
  </structured_output_contract>

  <privacy_contract>
  The evidence has been pre-genericized. Do not fabricate or echo
  proprietary identifiers, product names, or customer names, and do not
  de-anonymize a genericized surface to a specific named product.
  </privacy_contract>

  <grounding_rules>
  Frame the problem from the observable evidence; do not yet compare
  directions (that belongs to /designer:decide). Where a goal or
  constraint is inferred rather than evidenced, label it INFERENCE:.
  A success metric that cannot be observed is not a metric — say so.
  </grounding_rules>
  ```

- **Synthesis**: Compare problem models. AGREED items elevate confidence
  in the framing. CONFLICT items surface to the user as an ambiguous
  problem boundary that must be reconciled before decide / compose.

### Brainstorm (decide phase)

- **Purpose**: Independent design-direction generation
- **Subcommand**: `task`
- **Prompt template**:

  ```xml
  <task>
  Given this design decision, independently propose 2-3 candidate
  directions with tradeoffs.
  Decision: {genericized decision context from the Design Task Profile}
  Design context: {genericized surface / users / stage / platform}
  </task>

  <axis_awareness>
  Preset: {preset-id resolved from decision-axes.yml}
  Size: {minor | standard | major}
  Axes:
    - id: <axis-id>; label: <label>; question: <core question>; role: <decisive | supporting>; gate: <true when the veto gate>
    - ...
  Weights: {comma-separated id:weight | "uniform"}
  </axis_awareness>

  <structured_output_contract>
  For each direction:
  1. Name and one-sentence summary
  2. Key tradeoffs — when <axis_awareness> is present, express each
     tradeoff against the named axes' labels and roles (the decisive
     usability axis + the preset's archetype axis; supporting axes;
     the accessibility veto gate)
  3. Risk areas (usability / accessibility / conversion / consistency /
     feasibility)
  4. Accessibility gate verdict for the direction: PASS / CANDIDATE-FAIL
     (name the candidate WCAG A/AA barrier) / UNKNOWN — a candidate
     barrier is a veto, not a tradeoff to fold into the build plan
  </structured_output_contract>

  <privacy_contract>
  The decision context has been pre-genericized. Do not fabricate or echo
  proprietary identifiers and do not de-anonymize a genericized surface.
  </privacy_contract>

  <grounding_rules>
  Base directions on the actual design context provided. Pattern claims
  ("users always expect X") require a heuristic, standard, or design-system
  citation, or are marked INFERENCE:. Do not assume design-system
  components or engineering capacity the context does not state.
  Accessibility verdicts are CANDIDATE-level: you cannot certify
  conformance from a description alone.
  </grounding_rules>
  ```

- **Presence rule**: The `<axis_awareness>` block is emitted only when
  **both** hold: (1) the orchestrator resolved a design preset —
  `registry_fallback === false` on the `ResolvedDecisionContext` written
  by `../../../scripts/decide-registry.mjs resolve` (per ADR-0027 §5.6) —
  AND (2) the orchestrator is in **command mode** (`/designer:decide` or
  `$designer:decide`). Auto-activated mode never reaches a peer dispatch
  (per the decide SKILL's auto-activated path), so the block is omitted
  there. When either condition fails, the block is omitted and the peer
  falls back to free-form 2-3 directions — graceful degradation.
- **Snapshot rule**: When `<axis_awareness>` is present, the orchestrator
  captures `{preset_id, axes, size, weights}` in memory before dispatch
  and synthesis consumes that in-memory snapshot, NOT a re-read of
  `decision-axes.yml`. This pins the axis frame both sides shared even if
  the registry changes mid-dispatch. 사용성 usability is decisive in
  **every** designer preset (the common decisive axis; ≥2-decisive
  invariant per ADR-0027 §1.3), so synthesis can always rank directions
  on usability + the preset's archetype axis, and 접근성 accessibility is
  always the single veto gate.
- **XML escaping** (ADR-0027 §1.1 PR5 amendment, editorial rule): axis
  `labels.en` / `labels.ko` / `question` are free-text YAML fields
  interpolated **verbatim** into `<axis_awareness>` — the emitter does NOT
  escape on emission. Registry authors MUST keep them free of the
  text-node-breaking characters **`&` and `<`** (and `>` where the field
  would sit immediately before a `]]>` token).
  **Apostrophes and double-quotes are deliberately NOT covered**: XML's
  `'` and `"` predefined entities are required only inside attribute
  values, and these fields sit strictly in element-text positions. The
  shipped presets (`balanced`, `conversion`, `experience`, `clarity`)
  conform — several questions legitimately contain an apostrophe (e.g.
  "the product's existing patterns"), which is correct and must not be
  "fixed". Future presets follow the same narrowed rule.
- **Synthesis**: Merge direction sets per the four base categories. Add
  PEER-ONLY directions; elevate confidence for AGREED; present CONFLICT
  directions both ways for the user. When `<axis_awareness>` was present,
  additionally rate each PEER-ONLY direction against the snapshotted
  design axes before merging; tag a direction `[Peer · unmapped]` when
  its justification uses a concept orthogonal to the snapshot's axes, and
  surface the unmapped vocabulary so the user MAY widen the preset. This
  is a presentation sub-label on top of the four base buckets, not a
  fifth category. A peer-flagged candidate accessibility barrier on the
  locally-preferred direction is checked FIRST, before the decisive axes.

### Plan-verify (compose phase)

Applies to all `compose` profiles (`spec`, `flow`, `wireframe`): the peer
receives the genericized draft artifact and returns gaps.

- **Purpose**: Find gaps in the orchestrator's design artifact — missing
  states, unhandled error/empty/loading paths, unstated accessibility
  criteria, sequencing problems in the flow, assumptions presented as
  settled patterns
- **Subcommand**: `task`
- **Independence exception**: Receives the orchestrator's genericized
  draft artifact as input
- **Prompt template**:

  ```xml
  <task>
  Review this genericized design artifact (user flow / wireframe spec /
  CTA copy / information architecture / component spec) for gaps: missing
  screen or component states (empty, loading, error, partial, offline),
  unhandled flow branches and back/cancel paths, accessibility acceptance
  criteria that are absent or unfalsifiable, consistency departures from
  the stated design system, and assumptions presented as settled patterns
  without a standard or heuristic behind them.

  Artifact:
  {orchestrator's genericized draft spec / flow / copy}

  Original design request:
  {genericized user request}

  Surface / Platform: {surface; platform, viewport class, LTR/RTL}
  </task>

  <structured_output_contract>
  Return:
  1. Gaps: missing states, branches, or considerations
  2. Sequencing issues: steps that should come earlier/later in the flow
  3. Accessibility criteria holes: acceptance criteria that are missing,
     untestable, or that would not catch a candidate WCAG A/AA barrier
  4. Consistency departures: one-off patterns that fragment the system
  5. Unsupported assumptions: pattern claims that need a reference or a
     usability test
  </structured_output_contract>

  <dig_deeper_nudge>
  Check second-order dependencies (a confirmation step that assumes an
  undo, a CTA that assumes a value proposition stated one screen earlier),
  and what must be true for the flow's riskiest step to succeed on the
  smallest supported viewport.
  </dig_deeper_nudge>

  <completeness_contract>
  Do not stop at surface observations. Trace every screen's states and
  every branch's exit path fully. An unnamed error path is a gap.
  </completeness_contract>

  <privacy_contract>
  The artifact has been pre-genericized. Do not fabricate or echo
  proprietary identifiers and do not de-anonymize a genericized surface.
  </privacy_contract>

  <grounding_rules>
  Ground every gap in a specific artifact section, a heuristic, or a WCAG
  checkpoint. Label inferences INFERENCE:.
  </grounding_rules>
  ```

- **Synthesis**: Incorporate valid gaps into the artifact and its
  acceptance criteria. Adjust sequencing for valid ordering issues. Note
  CONFLICT items for user resolution.

### Review (critique phase)

The peer's contribution is the **code/text perspective**; the
orchestrator holds the vision perspective (host-direct). Both are held to
`../../critique/references/quality-criteria.md`.

- **Purpose**: Independent multi-lens review of a design spec, or of the
  frontend code behind a rendered screen
- **Subcommand**: `task`
- **Prompt template**:

  ```xml
  <task>
  Review this genericized design artifact independently across the design
  quality lenses: usability (Nielsen's 10 heuristics), accessibility
  (WCAG A/AA — CANDIDATE issues only), conversion (CTA clarity, hierarchy,
  funnel friction), and consistency (design-system and platform-pattern
  conformance).

  Artifact (design spec text and/or frontend component code — no image):
  {orchestrator-collected genericized artifact}

  Design context: {genericized surface / users / stage / platform}
  Active lens(es): {usability | a11y | conversion | consistency | all four}
  </task>

  <structured_output_contract>
  Return findings as:
  - target (section / component / element) — severity
    (CRITICAL|MAJOR|MINOR|SUGGESTION) — lens — description — the criterion
    it violates (heuristic number, WCAG success criterion, or design-system
    rule)
  Group by severity. CRITICAL = an unmitigated accessibility veto gate
  (a candidate WCAG A/AA barrier), or a defect that blocks the user's task;
  SUGGESTION = an improvement that does not gate the design. Include
  "Looks Strong" observations at the end.
  </structured_output_contract>

  <dig_deeper_nudge>
  Trace the artifact's load-bearing interaction assumptions. What happens
  on the error path, on the smallest viewport, with a screen reader, with
  the network slow? Which single element, if wrong, makes the primary task
  unachievable?
  </dig_deeper_nudge>

  <vision_boundary>
  You have NOT seen the rendered screen — only code and text. Do not assert
  visual properties (contrast ratios, spacing, visual hierarchy, focus-ring
  appearance) as observed fact. Where a concern requires seeing the screen,
  name it as a question for the vision-capable reviewer instead of a
  finding. Structural evidence in the code (a missing label, a div-as-button,
  a hard-coded color pair) IS observable to you — report those normally.
  </vision_boundary>

  <privacy_contract>
  The artifact has been pre-genericized. Do not fabricate or echo
  proprietary identifiers and do not de-anonymize a genericized surface.
  Do not request an image; you have no image channel.
  </privacy_contract>

  <grounding_rules>
  Every finding references a specific target AND the criterion it violates.
  Label inferences INFERENCE:. Accessibility findings are CANDIDATE-level:
  focus order, keyboard traversal, and screen-reader behavior require
  runtime testing and cannot be certified from code alone. A weakness
  asserted without a heuristic, standard, or code citation is itself a
  low-grade finding.
  </grounding_rules>
  ```

- **Synthesis**: Merge findings by target. Same target + same issue →
  deduplicate, take higher severity. Unique findings → label source; a
  vision-only finding is LOCAL-ONLY by construction (Vision asymmetry
  rule). The orchestrator judges validity (drop invalid findings); it does
  not ask the user "is this an issue?". An unmitigated accessibility veto
  gate is CRITICAL by definition, whichever side found it.

### Refine-verify (refine phase)

- **Purpose**: Independent verification of an applied revision — does it
  actually resolve the finding, without introducing a new inconsistency
  or, the load-bearing design gate, **a new accessibility barrier**?
- **Subcommand**: `task`
- **Prompt template**:

  ```xml
  <task>
  Review this revision to a design artifact independently. Verify the
  change resolves the stated finding, does not introduce a new internal
  inconsistency (a flow step that no longer reconciles with the IA, a CTA
  that no longer matches the value proposition), and — the load-bearing
  gate — does not open a NEW candidate accessibility barrier. A revision
  that clears a usability or conversion problem by introducing a WCAG A/AA
  barrier has moved the veto gate, not cleared it.

  Revision (before → after of the changed elements — spec text and/or
  frontend code; no image):
  {orchestrator-collected genericized revision}

  Original finding / feedback:
  {genericized critique finding or feedback context}
  </task>

  <structured_output_contract>
  Return:
  1. Resolution assessment (does the revision address the stated finding?)
  2. Consistency risks (what other element / flow step may now contradict
     the change?)
  3. New accessibility barrier (did the change introduce a candidate WCAG
     A/AA barrier that was not there before? name the success criterion)
  4. New findings discovered while reviewing the revision
  5. What you could NOT verify without seeing the re-rendered screen
  </structured_output_contract>

  <verification_loop>
  Trace the changed elements end-to-end. Check that downstream elements
  (subsequent flow steps, the IA, the acceptance criteria, the measurable
  success metrics) still reconcile with the revised element.
  </verification_loop>

  <vision_boundary>
  You have NOT seen the re-rendered screen — only code and text. Do not
  assert visual properties as observed fact. List explicitly what a
  vision-capable reviewer must confirm.
  </vision_boundary>

  <privacy_contract>
  The revision has been pre-genericized. Do not fabricate or echo
  proprietary identifiers and do not de-anonymize a genericized surface.
  </privacy_contract>

  <grounding_rules>
  Every claim references a specific changed element. Label inferences
  INFERENCE:. Accessibility claims are CANDIDATE-level.
  </grounding_rules>
  ```

- **Synthesis**: Same as Review, scoped to the applied revision. A
  peer-flagged regression (a new inconsistency or a new candidate
  accessibility barrier) **pauses** the refine for user direction rather
  than auto-proceeding. Item 5 of the peer's output feeds the
  orchestrator's host-direct re-critique; when the re-rendered screen is
  unavailable, those items stay **UNVERIFIED** and the refine does not
  claim convergence.

### Reference-scan (investigate phase, design-brief profile)

- **Purpose**: Independent topic-bound external research producing cited
  design evidence per sub-question
- **Subcommand**: `task`
- **Canonical contract**:
  `../../investigate/references/design-brief-ensemble.md` (the full
  bidirectional protocol — privacy gate, the 5-tier design source
  taxonomy, citation remapping, Path A / Path B, dispatch via
  `../../../scripts/peer-runner.mjs`). This entry exists for parallelism
  with the other point types; the reference-scan prompt and synthesis
  machinery live in that file. Do NOT duplicate it here — cross-reference
  it from the investigate command's design-brief profile.
- **Synthesis**: Apply the bidirectional Independence Rule from the
  canonical contract — Path A locally verify and cite the PEER-ONLY claim,
  Path B move it to Open Questions. Citation numbering remaps to local
  capture order; the peer's internal labels MUST NOT be copied verbatim.
  The peer never invents `user-research` evidence (it has no first-party
  access). Source-of-discovery labels live in workflow phase notes only —
  the saved brief strips them per the Ensemble Label Policy.

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

### Peer asks for the screenshot

- **Detect**: The peer's output requests an image, or asserts a visual
  property (a contrast ratio, a spacing value) it could not have observed.
- **Action**: Do NOT send an image — there is no image channel. Treat an
  asserted-but-unobservable visual property as an INFERENCE, not a
  finding, and resolve it with the orchestrator's own host-direct vision
  read. If the orchestrator has no screen either, the item is UNVERIFIED.
- **Surface**: Record the unverified items in the synthesis.

### Large artifact / large surface scope

- **Detect**: For Review, the collected artifact scope exceeds a
  comfortably-promptable size (a whole flow's component tree plus its
  specs), or the peer task produces no output after a long wait on a
  known-large scope.
- **Action**: Segment by screen (or by lens). Issue one peer `task` per
  segment and aggregate findings at synthesis time, deduplicating shared
  concerns.
- **Surface**: "Scope exceeds slicing threshold — peer review issued in
  K segments."

### Graceful degradation principle

Ensemble failure must never block the workflow. Orchestrator-only results
are always sufficient to proceed — the brief, spec, or critique report is
always assembled and saved on the local-only path. The peer adds value
when available but is not required, and the saved artifact never reveals
whether the ensemble ran.

The one thing degradation must NOT do is quietly downgrade honesty: a
vision-grounded claim the orchestrator could not make (no screen) stays
UNVERIFIED whether or not the peer ran.

---

## Related

- `./orchestration.md` — designer's dynamic-orchestration framework and
  the Design Task Profile (Step 1) that every verb builds; records the
  `Ensemble Affinity` axis this protocol does not gate on, the L4
  profile → preset map, and the image L2 composition boundary.
- `../../investigate/references/design-brief-ensemble.md` — the canonical
  reference-scan contract (5-tier design source taxonomy, citation
  remapping, Path A / Path B). This file cross-references it for the
  reference-scan point rather than duplicating it.
- `../../investigate/references/design-brief-spec.md` — canonical brief
  structure, privacy gate, the accessibility honesty boundary, and the
  Ensemble Label Policy that strips `[Local]` / `[Peer]` / `[Both]` from
  saved artifacts.
- `../../critique/references/quality-criteria.md` — the single
  internalized quality standard (Nielsen's 10 heuristics, WCAG A/AA,
  conversion, consistency) both the orchestrator and the peer apply at
  the Review and Refine-verify points.
- `../../decide/references/decision-axes.yml` — the design decision-axis
  registry the Brainstorm point's `<axis_awareness>` block reads.
- `../../../scripts/peer-runner.mjs` — designer's managed peer runner
  (resolves + invokes the companion, writes the ledger, records
  `pending_ensemble`).
- `../../../scripts/dispatch-peer.mjs` — designer's blocking
  compatibility dispatcher for legacy/raw callers.
- `companions/contract.md` v0.1.1 — wire-spec contract for both companion
  bridges (`claude-companion`, `codex-companion`).
- `docs/adr/0008-companion-distribution-model.md` — companion
  distribution (cache-glob discovery + env override).
- `docs/adr/0010-plugin-boundary-policy.md` — 4-layer composition,
  naming, §5 no-import.
- `docs/adr/0042-designer-persona-design-ux-workbench.md` — the designer
  persona decision; SD4 / SD6 specify the vision boundary and the six
  design-anchored point templates this file lands.
