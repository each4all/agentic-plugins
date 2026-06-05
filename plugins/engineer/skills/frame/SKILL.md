---
name: frame
description: "Turns evidence into a structured problem model — goals, constraints, audience, success criteria, risks. The engineer persona's framing verb (per ADR-0010 §2 — addresses the gap omcc-dev exposed by going from evidence directly to decision without an explicit problem model). Use after investigate to crystallize the problem before deciding or composing. Trigger phrases include 'frame this', 'define the problem', 'what are we trying to solve', 'set up the problem', 'scope this out', 'problem statement', 'goals and constraints', '문제 정의', '어떤 문제인지', '정리해줘', '스코프 잡아줘'."
---

# Frame (engineer persona)

The engineer plugin's framing verb (per ADR-0010 §2). Frame turns
gathered evidence into a structured **problem model** before any
decision is made. ADR-0010 explicitly added this verb because omcc-dev
showed a recurring failure mode: evidence collected by Investigate was
consumed by Decide without an explicit problem statement, producing
"correct answers to the wrong question".

A good problem model articulates:

| Field | Question it answers |
|-------|---------------------|
| **Problem statement** | What is wrong / what gap exists, in 1-2 sentences? |
| **Goals** | What does success concretely look like? |
| **Audience** | Who consumes the result? (developers / end-users / operators / future maintainers) |
| **Constraints** | What technical, time, scope, compatibility limits apply? |
| **Success criteria** | How will we know this is done? (measurable) |
| **Risks** | What could go wrong, and how would we detect it? |
| **Out of scope** | What questions are deliberately deferred? |

This verb takes no `--profile` argument — frame is single-mode by
definition (the verb's purpose is articulating one problem model
per invocation). Sub-discipline context is supplied through the
orchestrator-level Task Profile per
`../_shared/references/orchestration.md`, not via per-call profile
arguments.

**Core principle**: frame before deciding. A misframed problem
consumes downstream decision/composition effort without producing
value. If the problem changes mid-stream, return to frame — do not
patch a decision built on the old framing.

---

## When auto-activated (without command)

Lightweight in-context framing — no subagent spawning, no peer
ensemble dispatch.

### Step 1: Receive evidence

Frame consumes evidence from one of three sources:

- Output of a prior `/engineer:investigate` run (the user pastes the
  symptom/finding block, or the orchestrator passes it explicitly).
- A `research_brief.md` produced by
  `/engineer:investigate --profile=cited-brief` (per ADR-0010 §5
  typed artifact handoff).
- The user's own description of what they observed.

If evidence is missing or thin, suggest running
`/engineer:investigate` first rather than framing on speculation.

### Step 2: Articulate the problem model

For each row of the table above, write 1-3 sentences. Mark uncertain
fields explicitly (`[unknown]`, `[to be confirmed]`) rather than
guessing. A frame with two `[unknown]` fields is more useful than a
frame that pretends certainty.

### Step 3: Present and confirm

Follow the Presentation Mode Protocol
(`../_shared/references/presentation-protocol.md`) before presenting.
Present the problem model as a single decision item (the model
itself) and ask the user:

> "Does this accurately capture the problem you want to solve, or
> should I adjust before we move on?"

Wait for user confirmation before any downstream action.

---

## When invoked by command (`/engineer:frame` Claude command or `$engineer:frame` Codex skill mention)

Full framing with peer ensemble parallel analysis.

### Step 1: Task Profile

Build the Task Profile per
`../_shared/references/orchestration.md` Step 1, capturing the
problem context, scope, layers, risks, complexity, and Ensemble
Affinity (recorded but not gating — always-max policy).

### Step 2: Local framing

Articulate the problem model from the evidence on hand (Step 2 above).
Mark uncertain fields explicitly.

### Step 3: Peer ensemble parallel analysis

Launch the peer ensemble per
`../_shared/references/ensemble-protocol.md` using the **Explore**
ensemble point type — frame is a problem-space exploration, not an
approach generation. The peer receives the same evidence the
orchestrator received and produces an independent problem model.

The peer call is automatic (always-max policy); skills do not pass
`--model` or `--effort` flags.

### Step 4: Synthesize

After both sides return:

1. Compare the two problem models field by field per
   `../_shared/references/ensemble-protocol.md` §Base Synthesis
   Categories.
2. AGREED fields → high confidence, present once.
3. LOCAL-ONLY / PEER-ONLY fields → present with source label; the
   user decides which to keep.
4. CONFLICT fields → present both interpretations; the framing
   conflict itself is often informative (it surfaces hidden
   assumptions).

### Step 5: Present

Follow the Presentation Mode Protocol
(`../_shared/references/presentation-protocol.md`) before presenting.
Use the same shape as auto-activated mode.

### State write (when invoked from a workflow command)

When `/engineer:frame` is invoked as a sub-step of a workflow
command, the invoking command writes the problem model to its
workflow file per `continuity-protocol.md` Phase-boundary Write
Rules (Deliverable D). This skill itself does not write workflow
state — it hands the model to the invoking command, which owns the
write.

When invoked standalone (no parent workflow command), no workflow
file write occurs.

---

## Completion — Active Next-Action Proposal

At the end of a successful frame (both the auto-activated and the command
path above), emit an **Active Next-Action Proposal** instead of a fixed
next verb, per `../_shared/references/entry-routing-contract.md`
§ Active Next-Action Proposal — derived from this frame, not a fixed
table:

```
- selected_next:         <verb | commit | owner decision>
- rejected_alternatives: <1-2 alternatives, each + one-line why-not>
- rationale:             <why best — 본질/근본 (essence/foundation) + Standards/Root-Cause gate>
- evidence_pointers:     <phase notes / files / artifacts — pointers only>
- confidence:            <HIGH | MEDIUM | LOW>
- next_command:          <exact next step: /engineer:<verb> … or $engineer:<verb> for a verb; the commit / owner-decision action otherwise>
```

Typical `selected_next` candidates for frame: `/engineer:decide` when 2+
approaches need comparison, or `/engineer:compose` when the direction is
already obvious. The routing table is the fallback only when evidence is
genuinely neutral — do not end with a hardcoded "next: X". When
`selected_next` is `engineer:decide`, also name the decision size
(`--size=minor|standard|major`) per the contract. The auto-activated path
stays lightweight (ADR-0029 §3): it emits this proposal shape and routing
reasoning without dispatching a peer.

---

## Session-level handoff preflight (ADR-0031)

As part of the completion footer (see the Completion section above), surface the
ADR-0031 session-level continue-vs-fresh preflight per
`skills/_shared/references/session-handoff.md`: compute the engineer workflow
projection and pass it to the runtime footer/check
(`--workflow-projection-file`) so the footer carries the continue-vs-fresh
decision. On detached HEAD, report "no active branch context" — do not
auto-recommend a fresh session. This mirrors the `/engineer:frame`
command's preflight so `$engineer:frame` on Codex surfaces it identically.

---

## Multi-axis lens at a 2+-branch point (ADR-0029 §2)

When this verb reaches a **genuine 2+-branch decision point** — two
viable problem framings, or two candidate scope boundaries, or a
non-neutral `selected_next` with 2+ candidates in the proposal above —
surface a **compact multi-axis lens** comparing the branches across the
decisive axes (본질/근본 essence/foundation) + the size-appropriate
supporting axes, instead of a flat list, per
`../_shared/references/entry-routing-contract.md`
§ "Surfacing the multi-axis lens from a non-decide verb".

Resolve the sized axis set from the shared `decide-registry.mjs`
resolver (`scripts/decide-registry.mjs resolve --size=<minor|standard|major>`)
— the single axis source of truth, not a hand-authored list. The lens
is bounded: only at a genuine 2+-branch point (not every invocation),
default `--size=minor` (compact 4-axis), never the full 9-axis matrix
for a trivial reversible step.

When the resolver CLI is not reachable — e.g. Codex auto-activated
skill mode, the registry-resolution asymmetry deferred under ADR-0013 —
keep the decisive axes 본질/근본 (essence/foundation, universal to every
preset) and read the size-appropriate supporting axes for the `compact`
preset directly from `../decide/references/decision-axes.yml` (the
registry file is readable even when the resolver CLI is not). Do not
hand-author a supporting-axis list here — the YAML stays the single
source.

---

## Anti-patterns (do not produce)

- **Framing without evidence**. Frame consumes investigate output;
  it does not invent observations.
- **Skipping the peer ensemble** in command mode. Engineer's
  policy is always-max — the peer ensemble exists precisely to
  surface framing CONFLICTs that single-perspective framing
  misses; skipping it is choosing to be wrong half the time.
- **Implementing or deciding before frame is confirmed**. Frame is
  the gate before `/engineer:decide` and `/engineer:compose`.
  Skipping the frame confirmation re-introduces the omcc-dev
  failure mode this verb was created to fix.
- **Pretending certainty on `[unknown]` fields**. Mark them
  explicitly. A frame with marked unknowns is honest; a frame that
  guesses is misleading.
