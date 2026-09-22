# Presentation Mode Protocol (orchestrator)

When presenting review items, findings, or decisions that require user attention, offer the user a choice of presentation mode. The goal: the user controls how they consume structured information, without sacrificing depth or detail.

The unit divided by the choice is the **decision item**, not the option. A single decision item may contain 2+ comparison options examined together; both modes preserve the same multi-perspective depth per item.

This protocol is plugin-local per ADR-0010 §5 cross-plugin import ban.

---

## When This Protocol Applies

Activates when you are about to present **multiple decision items** that require user review or decision:

- Macro plan subtasks (`/orchestrator:plan` — multiple subtasks, the dependency graph, the synthesized plan)
- Plan-verify ensemble findings (gaps, ordering issues, risks, edge cases)

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

- **Commands** (`/orchestrator:plan`): Ask once at the first presentation point. Apply the chosen mode to all subsequent presentation points within the same command invocation.
- **Skills** (auto-activated): Ask once before the first presentation.
- **Skills within commands**: When a skill is invoked as part of a command (not auto-activated), the command-level timing rule applies. Do not re-ask within the same command invocation.
- **Mode switching**: The user may request a switch at any time (e.g., "show me the rest all at once" or "let's go through these one by one"). Honor the request immediately. When switching from interview to batch mid-stream, present only the remaining unseen items. After the batch, deliver the aggregate synthesis covering all items (including those already reviewed in interview mode).
- **Shortcut**: If the user has already expressed a preference earlier in the conversation, apply it without re-asking. Re-ask only when a new command or skill is invoked.
- **Persistence**: When invoked from `/orchestrator:plan`, the chosen mode is recorded in the workflow's Markdown body as a phase note (`### Presentation mode: batch | interview`) rather than in frontmatter. The orchestrator schema 1.0 closed-key set does not promote `presentation_mode`; the body-note approach is intentionally retained because presentation-mode preference rarely needs machine-queryable retrospection.

---

## Mode 1: Batch (All at Once)

Present all decision items in a single structured output.

**Behavior:**
- Use the existing output formats (tables, lists, structured markdown) defined in the command/skill.
- Complete information in one cohesive output.
- No pauses between items.
- Each decision item retains its full depth: multi-perspective comparison + concrete evidence + recommendation.

---

## Mode 2: Interview (One by One)

Present decision items sequentially, one at a time, with a pause for user input between each.

**Behavior:**

1. **Show progress**: Begin each item with its position (e.g., "**[2/5]**").
2. **Present one decision item** with full detail — same depth as batch mode. When output token limits or context window constraints make batch mode less thorough, interview mode may include additional detail per item since the content is spread across multiple turns.
3. **Pause**: After presenting the item, wait for the user's response. The user may:
   - Ask follow-up questions about this item
   - Request changes or adjustments
   - Confirm and move to the next item (e.g., "next", "ok", "continue")
   - **Stop reviewing** (e.g., "stop", "that's enough") — no further actions are taken on remaining items, but a mandatory condensed summary of every unseen item (one line per item: position, headline, severity if applicable) is output so nothing is silently hidden
   - **Delegate remaining** (e.g., "proceed with recommendations", "handle the rest") — apply the recommended action for each remaining item, then present a summary of what was done
   - Switch to batch mode for remaining items
4. **Proceed** only after the user signals readiness.
5. **Synthesize** at the end: After all items are reviewed, deliver the aggregate sections required by the originating workflow. For `/orchestrator:plan`, the aggregate is the full synthesized macro plan with the dependency graph and recommended first subtask.

### Decision item taxonomy by content type

| Content Type | One Decision Item = |
|--------------|--------------------|
| Macro plan subtask (`/orchestrator:plan`) | One subtask with its branch, dependencies, status, and rationale |
| Plan-verify ensemble finding | One gap / ordering issue / risk / edge case with the affected subtask id and recommended action |

---

## Protocol Interaction Rule

Presentation mode changes only the delivery format, not the decision-making process. When an individual decision item contains or reveals a meaningful choice between 2+ approaches:

1. **Recognize**: A choice exists when the item presents 2+ distinct strategies (e.g., "subtask A could be split as A1+A2, or kept as one") — not when it merely lists variations of the same approach.
2. **Resolve inline**: Pause the current item's presentation, surface the comparison + recommendation, and wait for user choice. Resume after.
3. **Resume**: After the user decides, continue from where it paused.

This applies regardless of the originating content type. The item's original format may be extended to accommodate the comparison.

---

## Content Parity Rule

Both modes must present the **same decision items** with the **same depth of analysis**. The difference is purely in delivery format, not in content quality or completeness.

Exception: When technical constraints (output token limits, context window pressure) force batch mode to compress content, interview mode may provide greater per-item detail since it spreads the output across multiple turns. This is the only permitted asymmetry.

---

## Use of `AskUserQuestion`

The `AskUserQuestion` tool surfaces options as a multiple-choice UI. Reserve it for genuinely complex design decisions where all three hold:

- 2+ substantive alternatives exist
- A multi-perspective comparison has been produced
- The body of the message has presented the **multi-perspective comparison + recommendation** in full detail before the tool call

For trivial confirmations, yes/no follow-ups, or self-evident next steps, do **not** use `AskUserQuestion`. Use a plain text question instead, framed as: *"Recommended: X. Proceed?"*

If the user replies with "what's the difference?" / "compare them specifically" after a multiple-choice prompt, drop the tool, present the detailed comparison + clear recommendation in the body, and ask for plain-text confirmation.
