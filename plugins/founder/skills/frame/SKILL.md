---
name: frame
description: "Turns business evidence into a structured business problem model — the customer problem/opportunity, the job-to-be-done, the value and business-model hypothesis, constraints, validation criteria, and key risks. The founder persona's framing/ideation verb (ADR-0036 SD2/SD6 — 구상). Use after investigate to crystallize a candidate item into an explicit opportunity model before deciding or composing. Trigger phrases include 'frame this opportunity', 'is this a real opportunity', 'what problem are we solving', 'who is the customer', 'shape this business idea', 'opportunity model', 'value hypothesis', 'business problem statement', '사업 구상', '문제 정의', '어떤 기회인지', '고객이 누구', '가치 가설', '기회 정리'."
---

# Frame (founder persona)

The founder plugin's framing verb (per ADR-0010 §2, ADR-0036 SD2/SD6).
Frame turns gathered business evidence into a structured **business
problem / opportunity model** before any direction is chosen. This is the
**ideation** (구상) requirement: structuring a candidate item into an
explicit problem/opportunity model so the later decide/compose steps
answer the right question.

A good business problem model articulates:

| Field | Question it answers |
|-------|---------------------|
| **Problem / Opportunity** | What customer problem or market opportunity exists, in 1-2 sentences? |
| **Customer + Job-to-be-Done** | Who has the problem, and what job are they hiring a solution to do? |
| **Value hypothesis** | Why is this worth paying for — the wedge / unfair-advantage thesis? |
| **Business-model sketch** | How is value captured (revenue model, rough unit-economics direction)? |
| **Constraints** | What regulatory, capital, time, capability, or market-timing limits apply? |
| **Validation criteria** | What measurable evidence would confirm or refute the opportunity? |
| **Key risks** | What could kill it (market / regulatory / unit-economics / safety / execution), and how would we detect it early? |
| **Out of scope** | What questions are deliberately deferred? |

These business fields replace the engineer frame's software fields
(audience / success-criteria phrased for code) — ADR-0036 SD6 / F4. Frame
takes no `--profile` argument — it is single-mode by definition (one
opportunity model per invocation). Sub-discipline context flows through
the Business Task Profile per `../_shared/references/orchestration.md`,
not via per-call profile arguments.

**Core principle**: frame before deciding. A misframed opportunity
consumes downstream decision/composition effort without producing value
("a great plan for a market that does not exist"). If the opportunity
changes mid-stream, return to frame — do not patch a decision built on
the old framing.

---

## When auto-activated (without command)

Lightweight in-context framing — no peer ensemble dispatch.

### Step 1: Receive evidence

Frame consumes business evidence from one of three sources:

- Output of a prior `/founder:investigate` run (the user pastes the
  findings, or the orchestrator passes them explicitly).
- A `business_brief.md` produced by `/founder:investigate
  --profile=business-brief` (per ADR-0010 §5 typed artifact handoff).
- The user's own description of the candidate item and what they observed.

If evidence is missing or thin, suggest running `/founder:investigate`
first rather than framing on speculation — a frame built on an unverified
market is the failure mode this verb exists to prevent.

### Step 2: Articulate the opportunity model

For each row of the table above, write 1-3 sentences. Mark uncertain
fields explicitly (`[unknown]`, `[to be validated]`) rather than
guessing. A frame with two `[to be validated]` fields is more useful than
a frame that pretends certainty — and the marked gaps become the
`founder:investigate` / validation backlog.

### Step 3: Present and confirm

Present the opportunity model and ask the user:

> "Does this accurately capture the opportunity you want to pursue, or
> should I adjust before we move on?"

Wait for user confirmation before any downstream action.

---

## When invoked by command (`/founder:frame` Claude command or `$founder:frame` Codex skill mention)

Full framing with peer ensemble parallel analysis.

### Step 1: Business Task Profile

Build the Business Task Profile per
`../_shared/references/orchestration.md` Step 1 — Persona=founder, the
Market / Segment / Stage / Risk-class / Evidence-confidence fields, and
Ensemble Affinity (recorded but not gating — always-max policy).

### Step 2: Local framing

Articulate the opportunity model from the evidence on hand (Step 2
above). Mark uncertain fields explicitly.

### Step 3: Peer ensemble parallel analysis (Frame point)

Launch the peer ensemble using the **Frame** ensemble point — frame is a
problem-space exploration, not direction generation. The peer receives
the same business evidence the orchestrator received (genericized per the
privacy gate) and produces an **independent** opportunity model.

The privacy discipline of the business-brief ensemble applies here too:
PRIVACY GATE — proprietary venture concepts, interview/customer data, and
unpublished business material pass an explicit gate before BOTH web
search AND peer-host dispatch; genericize before the peer prompt, and the
pre-genericization value MUST never leave the local host. The peer call
is automatic (always-max policy); skills do not pass `--model` /
`--effort`. (founder's `../_shared/references/ensemble-protocol.md` §Frame
carries the prompt template + synthesis contract; the dispatch shape
mirrors the research-scan dispatch in
`../investigate/references/business-brief-ensemble.md`.)

### Step 4: Synthesize

After both sides return:

1. Compare the two opportunity models field by field per the base
   synthesis categories.
2. AGREED fields → high confidence, present once.
3. LOCAL-ONLY / PEER-ONLY fields → present with source label (in workflow
   phase notes only, never in a saved artifact); the user decides which
   to keep.
4. CONFLICT fields → present both interpretations; the framing conflict
   itself is often the most informative output — it surfaces hidden
   assumptions about the customer or the market.

### Step 5: Present

Use the same shape as auto-activated mode, at the deeper synthesized
fidelity. Present clearly and confirm before downstream verbs.

### State write (when invoked from a workflow command)

When `/founder:frame` is invoked as a sub-step of a founder workflow
command, the invoking command writes the opportunity model to its
workflow file. This skill itself does not write workflow state — it hands
the model to the invoking command, which owns the write. When invoked
standalone (no parent workflow command), no workflow file write occurs.

---

## Completion — Active Next-Action Proposal

At the end of a successful frame (both auto-activated and command path),
emit an **Active Next-Action Proposal** instead of a fixed next verb —
derived from this frame, not a fixed table:

```
- selected_next:         <verb | owner decision>
- rejected_alternatives: <1-2 alternatives, each + one-line why-not>
- rationale:             <why best — 본질/근본 (essence/foundation) + evidence-quality gate>
- evidence_pointers:     <opportunity-model fields / brief path — pointers only>
- confidence:            <HIGH | MEDIUM | LOW>
- next_command:          <exact next step: /founder:<verb> … or $founder:<verb> for a verb>
```

Typical `selected_next` candidates for frame: `/founder:decide` when 2+
business directions need comparison (name the size
`--size=minor|standard|major`), or `/founder:compose` when the direction
is already obvious. The routing is a fallback only when evidence is
genuinely neutral — do not end with a hardcoded "next: X".

(When the invoking workflow command's terminal write runs — `state.mjs
set-terminal` — the runtime completion footer is **code-emitted** on that
command's stderr per ADR-0039/ADR-0043 S3; do not hand-compose a second
footer — surface the emitted one. Standalone skill invocations write no
workflow state and emit no footer. Wiring:
`skills/_shared/references/session-handoff.md`.)

On Claude the Stop hook fires at **every turn end**, so that terminal write puts
the workflow in front of the archive gates at the end of **that same turn**, not
at session close — it archives then if every gate passes, and otherwise stays
marked for a later Stop to re-evaluate. Clearing the marker
(`--terminal-marker false`, with set-terminal's full flag set) works only before
that Stop fires and does not restore the previous phase. On Codex the hook runs
only once the operator has trusted the plugin hooks (`/hooks`), so evaluation
waits. Full contract: `skills/_shared/references/session-handoff.md`
§ Archive timing.

---

## Multi-axis lens at a 2+-branch point (ADR-0029 §2)

When this verb reaches a **genuine 2+-branch decision point** — two
viable opportunity framings, or two candidate customer segments — surface
a **compact multi-axis lens** comparing the branches across the decisive
business axes (시장성 market-attractiveness / 단위경제 unit-economics, per
ADR-0036 SD3) + size-appropriate supporting axes, instead of a flat list.
read the decisive axes from founder's decision registry
(`scripts/decide-registry.mjs` + `../decide/references/decision-axes.yml`),
or inline as above when the resolver is not reachable. Bounded: only at a
genuine 2+-branch point, never a full matrix for a trivial reversible step.

---

## Anti-patterns (do not produce)

- **Framing without evidence**. Frame consumes investigate output; it
  does not invent market observations. A frame built on speculation
  re-introduces the "great plan, no market" failure mode.
- **Skipping the peer ensemble** in command mode. founder's policy is
  always-max — the peer exists precisely to surface framing CONFLICTs
  (hidden customer/market assumptions) that single-perspective framing
  misses.
- **Deciding or drafting before frame is confirmed**. Frame is the gate
  before `/founder:decide` and `/founder:compose`.
- **Pretending certainty on `[to be validated]` fields**. Mark them
  explicitly — the marked gaps are the validation backlog. A frame that
  guesses is misleading.
- **Leaking proprietary material** to the peer. Genericize the venture
  concept and any customer/interview data before the peer prompt.
- **Professional-advice claims**. founder does not produce legal,
  financial, tax, or clinical advice (ADR-0036 Non-Goal 6); flag
  regulated-domain framings as needing a qualified professional.
