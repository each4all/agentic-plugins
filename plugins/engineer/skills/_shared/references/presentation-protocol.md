# Presentation Mode Protocol

When presenting review items, findings, or decisions that require user
attention, offer the user a choice of presentation mode. The goal: the user
controls how they consume structured information, without sacrificing depth
or detail.

The unit divided by the choice is the **decision item**, not the option. A
single decision item may contain 2+ comparison options examined together;
both modes preserve the same multi-perspective depth per item.

---

## When This Protocol Applies

Activates when you are about to present **multiple decision items** that
require user review or decision:

- Option comparisons (decide skill / its inline brainstorm equivalent)
- Code review findings (critique skill)
- Implementation plan tasks (compose skill)
- Investigation results (investigate skill — multiple hypotheses)
- Audit-scope findings (critique skill, full-codebase profile)
- Codebase exploration synthesis (investigate skill, analysis profile)

Does NOT apply to:
- Single-item presentations (one finding, one recommendation)
- Binary confirmations (yes/no)
- Progress updates or status reports
- Internal orchestration output

---

## Offering the Choice

At the first major presentation point in a command or skill workflow, ask:

> How would you like to review this?
> **(1) All at once** — full structured output in one view
> **(2) One by one** — walk through each item together, interview style

### Timing rules

- **Commands** (`/engineer:investigate`, `/engineer:critique`,
  `/engineer:decide`, etc.): Ask once at the first presentation point.
  Apply the chosen mode to all subsequent presentation points within the
  same command invocation.
- **Skills** (auto-activated): Ask once before the first presentation.
- **Skills within commands**: When a skill is invoked as part of a command
  (not auto-activated), the command-level timing rule applies. Do not
  re-ask within the same command invocation.
- **Mode switching**: The user may request a switch at any time (e.g.,
  "show me the rest all at once" or "let's go through these one by one").
  Honor the request immediately. When switching from interview to batch
  mid-stream, present only the remaining unseen items. After the batch,
  deliver the aggregate synthesis covering all items (including those
  already reviewed in interview mode).
- **Shortcut**: If the user has already expressed a preference earlier in
  the conversation, apply it without re-asking. Re-ask only when a new
  command or skill is invoked.
- **Persistence**: When invoked from `/engineer:*` commands that own a
  workflow file, the chosen mode is recorded in the workflow's Markdown
  body as a phase note (`### Presentation mode: batch | interview`)
  rather than in frontmatter. ADR-0011 §2 schema=1 is closed; the
  body-note approach keeps the chosen mode discoverable on resume
  without forcing a frontmatter extension. A future ADR may promote
  `presentation_mode` into frontmatter if dogfood reveals a strong
  need for machine-queryable persistence.

---

## Mode 1: Batch (All at Once)

Present all decision items in a single structured output.

**Behavior:**
- Use the existing output formats (tables, lists, structured markdown)
  defined in each command/skill.
- Complete information in one cohesive output.
- No pauses between items.
- Each decision item retains its full depth: multi-perspective comparison +
  concrete evidence + recommendation.

---

## Mode 2: Interview (One by One)

Present decision items sequentially, one at a time, with a pause for user
input between each.

**Behavior:**

1. **Show progress**: Begin each item with its position (e.g., "**[2/5]**").
2. **Present one decision item** with full detail — same depth as batch
   mode. When output token limits or context window constraints make batch
   mode less thorough, interview mode may include additional detail per
   item since the content is spread across multiple turns.
3. **Pause**: After presenting the item, wait for the user's response. The
   user may:
   - Ask follow-up questions about this item
   - Request changes or adjustments
   - Confirm and move to the next item (e.g., "next", "ok", "continue")
   - **Stop reviewing** (e.g., "stop", "that's enough") — no further
     actions are taken on remaining items, but a mandatory condensed
     summary of every unseen item (one line per item: position, headline,
     severity if applicable) is output so nothing is silently hidden
   - **Delegate remaining** (e.g., "proceed with recommendations", "handle
     the rest") — apply the recommended action for each remaining item,
     then present a summary of what was done
   - Switch to batch mode for remaining items
4. **Proceed** only after the user signals readiness.
5. **Synthesize** at the end: After all items are reviewed, deliver the
   aggregate sections required by the originating workflow (e.g.,
   comparison table and recommendation for the decide skill, summary
   counts for full-codebase critique, overall assessment for review).
   Then recap decisions made and actions agreed upon during the interview.

### Decision item taxonomy by content type

| Content Type | One Decision Item = |
|--------------|--------------------|
| Option comparison (decide) | One option with its multi-perspective analysis |
| Review finding (critique) | One finding with location, description, recommended action |
| Plan task (compose) | One task with description, completion criterion, dependencies |
| Investigation hypothesis (investigate) | One hypothesis with verdict, confidence, evidence |
| Audit-scope issue (critique full-codebase) | One issue with location, category, description, action |
| Exploration perspective (investigate analysis) | One perspective (Architecture / Flow / Conventions) |

### Worked Examples

The "One Decision Item =" anchor above is correct but compressed. The two
scenarios below show how that anchor renders in batch and interview modes.

#### Example 1 — 1 decision item with 4 options

Setup: a decide skill produced 4 candidate approaches (Option A/B/C/D) to a
single design decision. The "One Decision Item =" anchor for option
comparison is *one option with its multi-perspective analysis*.

**Batch mode** — single message containing:

1. The multi-perspective comparison table (rows = perspectives, columns = A/B/C/D)
2. Each option's full perspective analysis (4 blocks, in order)
3. The recommendation block (chosen option + rationale + alternative-conditions)

**Interview mode** — 4 sequential per-option segments + 1 aggregate, each
its own assistant turn with a pause for user input between:

1. `[1/4]` Option A — name, summary, multi-perspective analysis. Pause.
2. `[2/4]` Option B — same shape. Pause.
3. `[3/4]` Option C — same. Pause.
4. `[4/4]` Option D — same. Pause.
5. After all 4 reviewed: aggregate synthesis (comparison table +
   recommendation). Mandatory in interview mode per the synthesis rule
   above.

Total assistant segments: **5** (4 per-option + 1 aggregate).

#### Example 2 — 5 decision items with varied option counts

Setup: a plan has 5 tasks; each task internally has 2-4 viable
implementation alternatives (e.g., 4 / 2 / 3 / 4 / 2 = 15 options total
across the 5 tasks).

**Batch mode** — single message containing:

1. Item 1 with all 4 of its options inline (compact multi-perspective per
   option, plus per-item recommendation)
2. Items 2-5 in the same shape, in order
3. Cross-item synthesis if applicable (otherwise omit)

**Interview mode** — 5 per-item segments + 1 aggregate, **grouped per item,
not per option**:

1. `[1/5]` Item 1 with its 4 options compared inline. Pause.
2. `[2/5]` Item 2 with its 2 options compared. Pause.
3. `[3/5]` Item 3 with its 3 options compared. Pause.
4. `[4/5]` Item 4 with its 4 options compared. Pause.
5. `[5/5]` Item 5 with its 2 options compared. Pause.
6. After all 5 reviewed: aggregate synthesis covering all items.

Total assistant segments: **6** (5 per-item + 1 aggregate), **NOT 15**.

**Why per-item, not per-option** — the anchor is the decision item; its
options are shown together so the user evaluates one item's trade-off at a
time without losing cross-option framing. Splitting into 15 per-option
segments would shatter that framing and force the user to re-build
cross-option context across many turns. This grouping rule applies whenever
the "One Decision Item =" unit is itself a comparison container.

---

## Protocol Interaction Rule

Presentation mode changes only the delivery format, not the decision-making
process. When an individual decision item contains or reveals a meaningful
choice between 2+ approaches:

1. **Recognize**: A choice exists when the item presents 2+ distinct
   remediation paths, implementation strategies, or design alternatives —
   not when it merely lists variations of the same approach.
2. **Invoke inline**: Pause the current item's presentation and run the
   full decide skill (`skills/decide/SKILL.md`) within that item —
   Research, Compare across multiple perspectives, and Recommend.
3. **Resume**: After the user decides, continue the interview from where
   it paused.

This applies regardless of the originating content type (audit-scope
finding, review suggestion, plan task, etc.). The item's original format
may be extended to accommodate the comparison.

---

## Content Parity Rule

Both modes must present the **same decision items** with the **same depth
of analysis**. The difference is purely in delivery format, not in content
quality or completeness.

Exception: When technical constraints (output token limits, context window
pressure) force batch mode to compress content, interview mode may provide
greater per-item detail since it spreads the output across multiple turns.
This is the only permitted asymmetry.

---

## Use of `AskUserQuestion`

The `AskUserQuestion` tool surfaces options as a multiple-choice UI.
Reserve it for genuinely complex design decisions where all three hold:

- 2+ substantive alternatives exist
- The decide skill has already produced a comparison
- The body of the message has presented the **multi-perspective comparison
  + recommendation** in full detail before the tool call

For trivial confirmations, yes/no follow-ups, or self-evident next steps,
do **not** use `AskUserQuestion`. Use a plain text question instead, framed
as: *"Recommended: X. Proceed?"*

If the user replies with "what's the difference?" / "compare them
specifically" after a multiple-choice prompt, drop the tool, present the
detailed comparison + clear recommendation in the body, and ask for
plain-text confirmation.
