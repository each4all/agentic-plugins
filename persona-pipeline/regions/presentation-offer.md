## Offering the Choice

At the first major presentation point in a command or skill workflow, ask:

> How would you like to review this?
> **(1) All at once** — full structured output in one view
> **(2) One by one** — walk through each item together, interview style

### Timing rules

- **Commands** (`/{{persona}}:investigate`, `/{{persona}}:critique`,
  `/{{persona}}:decide`, etc.): Ask once at the first presentation point.
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
- **Persistence**: When invoked from `/{{persona}}:*` commands that own a
  workflow file, the chosen mode is recorded in the workflow's Markdown
  body as a phase note (`### Presentation mode: batch | interview`)
  rather than in frontmatter: presentation-mode preference rarely needs
  machine-queryable retrospection.
