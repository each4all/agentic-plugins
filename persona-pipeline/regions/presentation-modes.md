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
   aggregate sections required by the originating workflow (e.g., the
   comparison table and recommendation of a decide, summary counts of a
   critique). Then recap decisions made and actions agreed upon during the
   interview.
