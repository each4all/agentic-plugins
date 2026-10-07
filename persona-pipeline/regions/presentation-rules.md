### Worked Examples

The "One Decision Item =" anchor above is correct but compressed. The two
scenarios below show how that anchor renders in batch and interview modes.

#### Example 1 — 1 decision item with 4 options

Setup: a decide produced 4 candidate directions (A/B/C/D) for a single
decision. That is **one** decision item — one decision with its compared
directions — so this is a single-item presentation and the protocol does
not split it: there is no mode to offer, and the item is presented whole in
one message, in the order the decide output format sets:

1. Each direction's full analysis (4 blocks, in order)
2. The multi-perspective comparison table, after all directions (rows =
   axes, columns = A/B/C/D)
3. The recommendation block (chosen direction + rationale + any gate
   verdict its axes require + alternative-conditions)

Splitting it into per-option segments would break the comparison the item
exists for: the user weighs one decision's trade-off across its directions
at once.

#### Example 2 — 5 decision items with varied option counts

Setup: an artifact has 5 open items; each item internally has 2-4 viable
alternatives (e.g., 4 / 2 / 3 / 4 / 2 = 15 options total across the 5
items).

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
process: every confirmation and approval gate a verb states still applies,
in either mode. When an individual decision item contains or reveals a
meaningful choice between 2+ approaches:

1. **Recognize**: A choice exists when the item presents 2+ distinct
   directions, remediation paths, or structures — not when it merely lists
   variations of the same approach.
2. **Surface the lens inline**: Pause the current item's presentation and
   compare the branches with the compact multi-axis lens of
   `entry-routing-contract.md` § Surfacing the multi-axis lens from a
   non-decide verb (ADR-0029 §2), within that item. When the branch needs
   the full ritual (peer ensemble, sensitivity perturbation), recommend
   `/{{persona}}:decide --size=<tier>` instead of resolving it inline.
3. **Resume**: After the user decides, continue the interview from where
   it paused.

This applies regardless of the originating content type. The item's
original format may be extended to accommodate the comparison.

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
Reserve it for genuinely complex decisions where all three hold:

- 2+ substantive alternatives exist
- The decide skill has already produced a comparison
- The body of the message has presented the **multi-perspective comparison
  + recommendation** in full detail before the tool call

For trivial confirmations, yes/no follow-ups, or self-evident next steps,
do **not** use `AskUserQuestion`. Use a plain text question instead, framed
as: *"Recommended: X. Proceed?"*

{{#capability dispatch_target}}
**Autopilot mode (ADR-0063, Claude only):** there is no one to answer, so
proceed with X instead of asking (`autopilot-mode.md`). A choice that is a
genuine owner judgment is not a ceremony: it stops the step with its owner
gate (`entry-routing-contract.md` § Owner gates).

{{/capability}}
If the user replies with "what's the difference?" / "compare them
specifically" after a multiple-choice prompt, drop the tool, present the
detailed comparison + clear recommendation in the body, and ask for
plain-text confirmation.
