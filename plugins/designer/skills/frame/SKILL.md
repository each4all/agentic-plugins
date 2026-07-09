---
name: frame
description: "Turns design/UX evidence into a structured UX problem model — the user problem/experience gap, the job-to-be-done, the design goals, MEASURABLE UX success metrics, constraints, and key risks. The designer persona's framing verb (ADR-0042 SD2/SD4). Use after investigate to crystallize a design/UX task into an explicit problem model before deciding a direction or composing flows/specs. Trigger phrases include 'frame this UX problem', 'what are we designing for', 'who is the user', 'what job is this screen doing', 'define the UX goals', 'success metrics for this flow', 'UX problem statement', 'shape this design task', 'UX 문제 정의', '누구를 위한 화면', '무슨 작업을 돕는지', 'UX 목표', '성공 지표', '설계 문제 정리'."
---

# Frame (designer persona)

The designer plugin's framing verb (per ADR-0010 §2, ADR-0042 SD2/SD4).
Frame turns gathered design/UX evidence into a structured **UX problem
model** before any direction is chosen. This is where design **quality is
built in at the pre-code stage** (ADR-0042 SD4 item 1): frame fixes the
*measurable* UX success metrics and the constraints the later
decide/compose/critique steps are held to.

A good UX problem model articulates:

| Field | Question it answers |
|-------|---------------------|
| **UX Problem / Opportunity** | What user problem or experience gap exists, in 1-2 sentences? |
| **Users + Job-to-be-Done** | Who has the problem, and what job are they hiring this UI to do? |
| **Goals** | What must the design achieve — the user's goals AND the product goals? |
| **Measurable UX success metrics** | What *measurable* signals confirm the design worked — task-success rate, time-on-task, error rate, drop-off / completion, a usability score (e.g. SUS), conversion, and the target accessibility conformance level (WCAG A/AA)? Each metric names a target or direction, not a vibe. |
| **Constraints** | What platform, frontend-stack (code-first), design-system, accessibility-target, brand, or timeline limits apply? |
| **Key risks** | What could make the UX fail (usability / accessibility / adoption / consistency / feasibility), and how would we detect it early? |
| **Out of scope** | What questions are deliberately deferred? |

The **Measurable UX success metrics** row is load-bearing (ADR-0042 SD4):
"excluding Figma is not excluding quality" means the quality bar is made
explicit and measurable *here*, so `designer:critique` can later hold the
code-materialized UI to it. A frame whose success metric is "looks good"
is a misframe — restate it as something observable (e.g., "≥90% of
first-time users complete checkout without assistance; 0 WCAG A/AA
blockers on the primary path").

These design fields replace the founder frame's business-planning fields
— ADR-0042 SD2. Frame takes no `--profile` argument — it is single-mode by
definition (one UX problem model per invocation). Sub-discipline context flows through the Design
Task Profile (self-contained in the investigate skill at PR3; the shared
`../_shared/references/orchestration.md` Dynamic Orchestration reference
), not via per-call profile arguments.

**Core principle**: frame before deciding. A misframed UX problem consumes
downstream decision/composition effort without producing value ("a
beautiful screen for a task the user never had"). If the problem changes
mid-stream, return to frame — do not patch a decision built on the old
framing.

---

## When auto-activated (without command)

Lightweight in-context framing — no peer ensemble dispatch.

### Step 1: Receive evidence

Frame consumes design/UX evidence from one of three sources:

- Output of a prior `/designer:investigate` run (the user pastes the
  findings, or the orchestrator passes them explicitly).
- A `design_brief.md` produced by `/designer:investigate
  --profile=design-brief` (per ADR-0010 §5 typed artifact handoff).
- The user's own description of the surface, the users, and what they
  observed in the current frontend.

If evidence is missing or thin, suggest running `/designer:investigate`
first rather than framing on speculation — a frame built on an
unresearched pattern (or an unexamined current frontend) is the failure
mode this verb exists to prevent.

### Step 2: Articulate the UX problem model

For each row of the table above, write 1-3 sentences. Mark uncertain
fields explicitly (`[unknown]`, `[to be validated]`) rather than guessing.
A frame with two `[to be validated]` fields is more useful than a frame
that pretends certainty — and the marked gaps become the
`designer:investigate` / user-research backlog. **Every success metric
must be measurable** — if you cannot state how it would be observed, it is
a goal, not a metric; move it up to Goals and leave the metric marked
`[to be validated]`.

### Step 3: Present and confirm

Present the UX problem model and ask the user:

> "Does this accurately capture the design problem you want to solve, and
> are these the right measurable success metrics, or should I adjust
> before we move on?"

Wait for user confirmation before any downstream action.

---

## When invoked by command (`/designer:frame` Claude command or `$designer:frame` Codex skill mention)

Full framing with peer ensemble parallel analysis.

### Step 1: Design Task Profile

Build the Design Task Profile (Persona=designer, the Surface / Users /
Stage / Platform / Evidence-confidence fields, and Ensemble Affinity —
recorded but not gating, always-max policy). The profile shape is
self-contained in `../investigate/SKILL.md` § Design Task Profile at PR3;
the shared `../_shared/references/orchestration.md` reference.

### Step 2: Local framing

Articulate the UX problem model from the evidence on hand (Step 2 above).
Mark uncertain fields explicitly; make every success metric measurable.

### Step 3: Peer ensemble parallel analysis (Frame point)

Launch the peer ensemble using the **Frame** ensemble point — frame is a
problem-space exploration, not direction generation. The peer receives the
same design/UX evidence the orchestrator received (genericized per the
privacy gate) and produces an **independent** UX problem model.

The privacy discipline of the design-brief ensemble applies here too:
PRIVACY GATE — proprietary UI, unreleased features/flows, customer data
visible in screenshots, and secret-bearing frontend code pass an explicit
privacy gate before BOTH web search AND peer-host dispatch; genericize
before the peer prompt, and the pre-genericization value MUST never leave
the local host. **Screenshots are sensitive by default** and are never
sent to the peer as bytes (the peer path is code/text-based; vision
critique is a same-host `designer:critique` capability). The peer call is
automatic (always-max policy); skills do not pass `--model` / `--effort`.

Build the Frame prompt and dispatch in the background:

```xml
<task>
Independently build a UX problem model from the evidence below.
Do not see the local host's model — produce a fresh, independent one.

Genericized design/UX evidence: {genericized brief findings / topic}
Platform(s): {delivery context, or "unspecified"}
</task>

<structured_output_contract>
Return one UX problem model with these fields:
1. UX Problem / Opportunity (1-2 sentences)
2. Users + Job-to-be-Done
3. Goals (user goals + product goals)
4. Measurable UX success metrics (task-success rate, time-on-task, error rate, completion/drop-off, usability score, conversion, target WCAG level — each with a target or direction)
5. Constraints (platform / frontend-stack / design-system / accessibility-target / brand / timeline)
6. Key risks (usability / accessibility / adoption / consistency / feasibility) + early-detection signal
7. Out of scope
Mark uncertain fields [to be validated] rather than guessing.
</structured_output_contract>

<privacy_contract>
The evidence has been pre-genericized. Do not fabricate or echo
proprietary identifiers, product names, or customer names, and do not
de-anonymize a genericized concept to a specific named product. No
screenshot or image is included; do not request or assume one.
</privacy_contract>
```

Then write that prompt to a tempfile and dispatch:

```bash
PROMPT_FILE="$(mktemp -t designer-frame-prompt.XXXXXX).xml"
# ADR-0017 §sub-decision 4 — stable run-id BEFORE dispatch.
RUN_ID="frame-$(date -u +%Y%m%dT%H%M%SZ)-$(printf '%06x' $((RANDOM*RANDOM & 0xffffff)))"
# ... LLM writes the Frame XML prompt to $PROMPT_FILE (privacy gate must have passed; no screenshot bytes) ...
node "$CLAUDE_PLUGIN_ROOT/scripts/peer-runner.mjs" run \
  --repo-root "$REPO_ROOT" --kind ensemble \
  --peer codex --prompt-file "$PROMPT_FILE" --output-format json \
  --workflow-path "$ACTIVE" --phase frame \
  --host "${AGENTIC_HOST:-claude}" --cwd "$REPO_ROOT" \
  --ensemble-type frame --run-id "$RUN_ID" \
  > "$PROMPT_FILE.run.json" 2> "$PROMPT_FILE.err" &
```

Graceful degradation: companion missing or exit code 3
(`peer_cli_not_found` / `peer_unauthenticated` / `peer_invocation_error`)
→ proceed local-only and record "### Ensemble degraded:" in the body.

(designer's `../_shared/references/ensemble-protocol.md` §Frame — landing
carries the formal prompt template + synthesis contract; the
Frame dispatch shape above mirrors the reference-scan dispatch in
`../investigate/references/design-brief-ensemble.md`.)

### Step 4: Synthesize

After both sides return:

1. Compare the two UX problem models field by field per the base
   synthesis categories.
2. AGREED fields → high confidence, present once.
3. LOCAL-ONLY / PEER-ONLY fields → present with source label (in workflow
   phase notes only, never in a saved artifact); the user decides which to
   keep.
4. CONFLICT fields → present both interpretations; the framing conflict
   itself is often the most informative output — it surfaces hidden
   assumptions about the user, the task, or the success metric.

### Step 5: Present

Use the same shape as auto-activated mode, at the deeper synthesized
fidelity. Present clearly and confirm before downstream verbs.

### State write (when invoked from a workflow command)

When `/designer:frame` is invoked as a sub-step of a designer workflow
command, the invoking command writes the UX problem model to its workflow
file. This skill itself does not write workflow state — it hands the model
to the invoking command, which owns the write. When invoked standalone (no
parent workflow command), no workflow file write occurs.

---

## Completion — Active Next-Action Proposal

At the end of a successful frame (both auto-activated and command path),
emit an **Active Next-Action Proposal** instead of a fixed next verb —
derived from this frame, not a fixed table:

```
- selected_next:         <verb | owner decision>
- rejected_alternatives: <1-2 alternatives, each + one-line why-not>
- rationale:             <why best — 본질/근본 (essence/foundation) + evidence-quality gate>
- evidence_pointers:     <UX-problem-model fields / brief path — pointers only>
- confidence:            <HIGH | MEDIUM | LOW>
- next_command:          <exact next step: /designer:<verb> … or $designer:<verb> for a verb>
```

Typical `selected_next` candidates for frame: `/designer:decide` when 2+
design directions need comparison (name the size
`--size=minor|standard|major`), or `/designer:compose` when the direction
is already obvious. The routing is a fallback only when evidence is
genuinely neutral — do not end with a hardcoded "next: X".

**Incubating note (ADR-0042).** The full designer surface is installed as of
PR6: the six cognitive verbs (`investigate` / `frame` / `decide` / `compose` /
`critique` / `refine`), the `/designer:start` lifecycle macro, and the
`resume` / `checkpoint` / `peer-now` meta skills. Every `next_command` this
proposal can name is runnable. The persona is still **incubating**: ADR-0042 is
`Proposed` and flips to `Accepted` after the PR7 real-topic dogfood, so the SD3
decision axes and the SD4 quality lenses remain PROVISIONAL. The UX problem model is the
durable handoff either way.

Always include the workflow path:

```
Workflow: <absolute path to workflow .md file>
```

(The inline Active Next-Action Proposal shape above is what designer
ships; the deeper runtime-completion-footer / ADR-0031 session-handoff
seam integration that the engineer plugin carries is future work, not part
of designer's surface.)

---

## Multi-axis lens at a 2+-branch point (ADR-0029 §2)

When this verb reaches a **genuine 2+-branch decision point** — two viable
UX problem framings, or two candidate user segments / primary jobs —
surface a **compact multi-axis lens** comparing the branches across the
decisive design axes (usability 사용성 + the context lens the question
turns on, with accessibility 접근성 as the veto gate, per ADR-0042 SD3) +
size-appropriate supporting axes, instead of a flat list. The designer
decision registry (`scripts/decide-registry.mjs` +
`../decide/references/decision-axes.yml`) is the axis source of truth and
lands at PR4; until then read the decisive axes inline as above. Bounded:
only at a genuine 2+-branch point, never a full matrix for a trivial
reversible step.

---

## Anti-patterns (do not produce)

- **Framing without evidence**. Frame consumes investigate output (and the
  current frontend); it does not invent user observations. A frame built
  on speculation re-introduces the "beautiful screen, no real task"
  failure mode.
- **Unmeasurable success metrics**. "Looks modern", "feels intuitive" are
  not metrics — restate as observable signals (task-success rate,
  time-on-task, error rate, WCAG level) or mark `[to be validated]`. The
  measurable metric is what `designer:critique` later holds the UI to
  (ADR-0042 SD4).
- **Skipping the peer ensemble** in command mode. designer's policy is
  always-max — the peer exists precisely to surface framing CONFLICTs
  (hidden user/task/metric assumptions) that single-perspective framing
  misses.
- **Deciding or composing before frame is confirmed**. Frame is the gate
  before `/designer:decide` and `/designer:compose`.
- **Pretending certainty on `[to be validated]` fields**. Mark them
  explicitly — the marked gaps are the validation backlog. A frame that
  guesses is misleading.
- **Leaking proprietary material** to the peer. Genericize the UI concept
  and any customer/user data before the peer prompt; screenshots are
  sensitive by default and never sent as bytes.
- **Treating accessibility as a nice-to-have**. The target WCAG
  conformance level is a first-class success metric and a hard constraint
  (SD4 veto), not an optional polish item — name it in the frame.
