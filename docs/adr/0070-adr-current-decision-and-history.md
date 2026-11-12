# ADR-0070: An ADR states its current decision; its history lives in a companion file

## Status

Proposed (2026-11-12). The owner accepts it on merge (§ Process in
[`README.md`](README.md)); the matching changes to `AGENTS.md`,
`docs/adr/README.md` and `docs/adr/template.md`, made in the same change,
take effect with that acceptance.

Subtask W6-policy of macro `macro-plan-20261109T081853Z-8a34a1` (the weight
diet, C178), which reserved the number. Migrating ADR-0063 and ADR-0069
(W6-migrate-a) and ADR-0067 and ADR-0068 (W6-migrate-b) is left to those
subtasks.

## Context

**The files grew with every correction.** An Accepted ADR is amended in
place: each correction lands as dated text inside or after the decision it
changes, and each implementation adds a dated note. Measured on 2026-11-12
(each `## ` section's bytes, its heading line included):

| ADR | Bytes | Decision | Implementation notes | Amendments (own sections) | Status |
|---|---:|---:|---:|---:|---:|
| 0068 | 382,655 | 136,974 | 162,151 | 20,101 | 12,653 |
| 0067 | 170,444 | 126,257 | — | 12,105 (applied cascade) | 4,599 |
| 0063 | 151,369 | 38,658 | 56,659 | 27,990 + 6,001 (applied cascade) | 4,002 |
| 0069 | 76,909 | 43,441 | 3,509 | — | 1,576 |

The Decision column is not all current decision either: ADR-0068's carries
four "Left to the implementation" sections and four "Amendments (slice N)"
sections, and its Status section alone runs to 200 lines. The index in
`README.md` had grown the same way: 88,107 bytes, one row of ADR-0068
4,701 characters, because each row restated its ADR's decision.

**What a reader loads.** Three readers open these files:

- An agent on Claude Code reads a file with its Read tool from the top. In
  the default read mode a read returns at most 25,000 tokens (measured in
  this subtask's session, 2026-11-12: the `README.md` read stopped at line
  89 of 136, at 32,373 tokens), and the host's tools reference (§ Large
  files, as the Codex peer of this subtask cited it; not measured here)
  says a default whole-file read refuses a file over 256 KB, which
  ADR-0068's 382,655 bytes are. Either way the agent reaches ADR-0068's later decisions only
  through several ranged reads (or an explicit large read that loads all
  of it), each paying for the Status, Context and history placed before
  them. The cost that matters is the bytes a reader consumes to reach the
  current decision, and the whole-file payload for a reader that takes it
  all.
- A Codex peer reads through the shell (`sed`, `cat`, `rg`), choosing its
  ranges, and a prompt that embeds an ADR embeds the whole file.
- A person reading on GitHub scrolls one page.

Each of them reads from the top and has to find the current decision among
its history. An appendix at the end of the same file helps a reader that
reads a prefix and stops, once the current decision is in front; it does
nothing for a whole-file embed or a large read, which take the appendix
with them, nor for the 256 KB refusal. A companion file serves both.

**Citations bind to today's text.** Citations across the repository name
an amendment by its date. At base `737b03e9`, the extended regular
expression `ADR-0[0-9]{3}[^.;)]{0,60}amendment of [0-9]{4}-[0-9]{2}-[0-9]{2}`
matches 332 times under `git grep -E -o` (175 of them ADR-0059's, 80
ADR-0063's, 45 ADR-0068's), variant spellings such as `ADR-0063 amendment
of` and `ADR-0063 D1/D7, amendment of` included, most in runbooks,
generated persona files and code comments; these are matches, not
distinct citations. Four distinct anchor links point
into ADRs (`0022-…md#amendments` eleven times, `0006-…md#amendments` six
times, one ADR-0059 amendment heading three times, `0010-…md#amendments`
once). Eight `path:line` citations point at ADR lines. A layout change
that breaks these, or forces rewriting 332 strings in four release
packages (designer, engineer, founder, orchestrator) and the shared
`persona-pipeline/`, `scripts/` and `tests/`, would cost more than it
saves.

**Status can be mixed.** ADR-0069 is Accepted for Decisions 1 and 2 and
Proposed for 3 and 4; ADR-0037 is partly superseded and partly amended. A
reader has to see that per decision, at the top, without reading history.

## Decision

### Decision 1. The ADR file states the current decision; a companion file holds its history

1. **Two files.** `docs/adr/NNNN-<slug>.md` (the ADR) states the decision
   as it stands now. `docs/adr/history/NNNN-<slug>.md` (its history, the
   same basename) holds the dated record of how it got there. A history
   file exists only once there is history to hold. `docs/adr/*.md` stays
   the set of ADRs plus `README.md` and `template.md`, so a glob or a
   listing of ADRs does not pick up history files.
2. **What the ADR keeps.** The five core sections of the template plus a
   closing `## History`, holding:
   - **Status:** the status of the ADR, or of each decision when they
     differ, one line each, with the date and who accepted it when that is
     recorded. Nothing else: shipped versions, pull requests and slice
     narratives go to the history.
   - **Context:** the forces that explain the current decision, with the
     measurements a reader needs to judge it. Superseded context and
     measurement logs go to the history, with a pointer where a reader may
     want them.
   - **Decision:** the operative text, with every amendment folded in.
     Each decision or item that an amendment changed carries one dated
     marker, `*Amended YYYY-MM-DD (subject): [history](history/NNNN-<slug>.md#anchor).*`,
     on the item it changed. A "Left to the implementation" list stays
     until the implementation decides it; then the binding outcome becomes
     decision text and the list moves to the history.
   - **Consequences** and **Alternatives Considered:** as now. Alternatives
     that only a superseded portion rejected may move to the history.
   - A last section, `## History`, lists the history file's records, one
     line each: date, kind (amendment, implementation note, observation,
     superseded text) and subject, linked.
3. **What the history holds.** Every dated amendment as it was written,
   implementation notes, observations, applied amendment cascades, the
   "Left to the implementation" lists once decided, superseded decision
   text, and the shipped records the Status section used to carry. It
   opens with `# ADR-NNNN history: <title>` and one line saying it is the
   record and the ADR is the decision; records follow in date order, each
   under a `## ` heading. A moved record keeps its heading text exactly; a
   new one is headed `## Amendment YYYY-MM-DD — <subject>` (or
   `Implementation note`, `Observation`). The history is the record, so a
   record in it is never rewritten, only added to.
4. **Amending from now on.** An amendment edits the ADR's decision text to
   the new current decision, adds the dated marker to the item it changed,
   and appends its record to the history in the same change: what changed,
   why, and the wording it replaced when a reader may need it. Whether a
   change is an amendment or a supersede is decided as before
   (§ Amendments vs Supersedes in [`README.md`](README.md)); a supersede
   still writes a new ADR. An implementation note goes to the history
   only; when the implementation changes the decision, the same
   discriminator applies: a clarification or cascade is an amendment, a
   reversal a superseding ADR.
5. **Size.** The ADR aims to be readable in one read of the host's read
   tool (25,000 tokens on Claude Code, about 100 KB of this repository's
   prose). It is an aim, not a gate: no check enforces it, and an ADR
   whose current decision is longer stays longer.
6. **The index.** A row of the index in `README.md` holds the ADR's title,
   as its heading gives it, and its status. The decision itself is read
   in the ADR. This change applies that to every row.
7. **Which ADRs move.** An ADR moves to this layout when it is next
   amended, or when a subtask migrates it (ADR-0063, ADR-0067, ADR-0068
   and ADR-0069 by W6-migrate-a and W6-migrate-b). An ADR not yet moved
   stays valid as written, its in-file amendments included. Migrating an
   ADR changes no decision and no status. It moves records by what they
   say, not by their section's label: every rule still in force, wherever
   it stands (an implementation note, an observation, the Status section,
   a "Left to the implementation" list), is stated in the decision text
   with a dated marker, and its original record goes to the history as
   written. ADR-0068's implementation note of 2026-11-03 (C168), which
   decides the forced verification step's authorization scope and
   lifetime, is such a case. A migration reports the ADR's bytes before
   and after, and the bytes the reader loads to reach the last decision.

### Decision 2. Citations stay valid across the move

1. **Anchors.** A heading in the ADR keeps its exact text, so its GitHub
   anchor does not change; decision headings are never renamed by a
   migration. A heading moved to the history keeps its exact text too, so
   its anchor is the same in the history file; every live link to it
   (`NNNN-<slug>.md#anchor`) is rewritten in the same change to
   `history/NNNN-<slug>.md#anchor`. A link from a dated record (below) is
   rewritten as well when it would otherwise break, since a broken link
   serves no reader; its text is not changed.
2. **Dated citations.** A citation of the form `ADR-NNNN Decision N,
   amendment of YYYY-MM-DD` stays valid without rewriting: the date names
   the record in the history, and the dated marker on the item shows where
   its effect now stands in the decision. A migration therefore keeps a
   record for every amendment date a citation names, and keeps the labels
   citations use (a decision number, an item number or letter such as
   ADR-0059's item (j)) on the text they label, wherever it lands. A
   citation whose label could not be kept is rewritten in the same change.
3. **`path:line` citations.** A live citation, one that makes a present
   claim (a code comment, a runbook, `AGENTS.md`, the present text of
   another ADR), is updated in the same change to the line where the text
   now stands, in the ADR or its history. A historical citation, one inside
   dated text (an amendment or implementation note of any ADR, the frozen
   records under `docs/assurance/`, `docs/audits/` and
   `docs/release-proofs/`, a changelog, a commit message), keeps its form:
   its date says which revision it read, and the repository's history
   resolves it. A paragraph that mixes both keeps its text and gains a
   dated pointer to the new location.
4. **Mixed status stays visible.** The Status section lists each decision
   whose status differs from the ADR's on a line of its own, and the
   decision's body states it on the first line under the decision's
   heading when it is not Accepted, for example `Status: Proposed.`. The
   status never goes in the heading, new or existing: the heading text is
   its anchor (item 1), and accepting the decision would rename it and
   break every link made meanwhile. Status is kept down to the clause:
   text folded into an Accepted decision that comes from, or depends on,
   a Proposed decision or amendment (ADR-0069's Decision 2 narrowed by its
   Proposed Decision 3 is one) stays marked Proposed at that clause, with
   its provenance, and folding never promotes it. A superseded decision keeps its heading in the ADR with one line naming
   the ADR that superseded it and linking the superseded text in the
   history. Only the owner changes a status; a migration carries each one
   over as it is.

## Consequences

**Positive**

- A reader of an ADR loads the current decision first and only. Measured
  ADR-0068 sections put roughly half its bytes (the implementation notes
  and amendment sections, 182 KB, plus most of a 12.6 KB Status) in its
  history before any folding of the inline slice amendments.
- The index shrinks from 88 KB to the titles and statuses, and reads in one
  pass.
- The 332 dated citation matches need no rewrite, and the history keeps
  every record a citation names.
- An amendment's record is still kept as written, so the evidence for a
  decision is not lost, only moved one link away.

**Negative**

- An amendment touches two files and has to fold its change into the
  decision text, which is more work than appending a dated section, and a
  fold can misstate the decision. The record in the history is the check:
  a reviewer compares the folded text against it.
- A reader who wants the reasoning behind a past change follows a link.
- `rg` over `docs/adr/` returns history matches beside current ones; the
  path (`history/`) tells them apart.

**Neutral**

- ADRs not yet migrated keep their in-file amendments, so for a while the
  repository has both layouts. Decision 1, item 7 bounds that to ADRs not
  amended since.
- Nothing checks the layout mechanically; review holds it, as it holds the
  rest of the ADR process.

## Alternatives Considered

- **An appendix at the end of the same file.** The macro plan's first
  choice. Rejected by what readers load (§ Context): it helps a reader
  that stops after a prefix, but a whole-file embed or large read still
  takes all of it, and the default read still refuses a file over 256 KB.
- **History in the git log only, no history file.** The commit that
  amended an ADR already records the diff. Rejected: the dated record often
  carries the reasoning and the measurements, which a diff does not, and
  332 citation matches name records by date that `git log` cannot resolve
  by name.
- **A new ADR for every amendment.** Each correction becomes a short ADR
  that amends its parent. Rejected: the current decision would then be
  spread across a chain of ADRs, which is the reader's problem in another
  form, and the number sequence would fill with clarifications.
  Supersedes keep writing new ADRs (§ Amendments vs Supersedes).
- **History beside the ADR as `NNNN-<slug>.history.md`.** Rejected for
  `history/NNNN-<slug>.md`: the sibling form puts history files in every
  `docs/adr/*.md` listing and glob, which then has to exclude them.
- **Rewriting the dated citations to a new form.** Rejected: 332 strings,
  most in generated runbook text, releasing four persona and capability
  packages, to
  gain nothing a dated marker on the item does not already give.
- **A size gate.** A check that fails an ADR over a byte budget. Rejected:
  the owner's direction for this macro is fewer checks, and a long current
  decision is not a defect.

## History

None yet.
