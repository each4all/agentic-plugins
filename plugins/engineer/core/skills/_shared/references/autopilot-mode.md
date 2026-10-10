# Autopilot mode (engineer, Claude only)

[ADR-0063](../../../../../../docs/adr/0063-autopilot-fresh-session-driver.md)
adds an owner-launched driver that runs one engineer command per fresh
`claude -p` process and decides the next step from durable state. This file
holds the rules those commands follow while they run under it, and the owner
gates they record in either mode. It is the one copy; the "Autopilot mode"
paragraphs in the verb commands, `/engineer:commit`,
`presentation-protocol.md` and `ensemble-protocol.md` point here.

**Codex:** autopilot mode is Claude-only (ADR-0063 D9). The owner gates below
are host-shared state; the autopilot rules do not apply on Codex.

## When it is on

When `AGENTIC_AUTOPILOT` names an autopilot run
(`autopilot-YYYYMMDDTHHMMSSZ-xxxxxx`). An empty or malformed value is off, so
an accidental global export changes nothing.

A runbook never tests the variable itself. Each verb's Phase 0 runs, before
any write:

```bash
node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" autopilot-preflight \
  --workflow-path "$ACTIVE" --host "${AGENTIC_HOST:-claude}" || exit $?
```

and `/engineer:commit` runs it with `--surface commit`, whose rules differ.

- **Interactive, no owner gate:** it prints nothing, and the command runs as it
  always has.
- **Autopilot:** it prints a banner beginning `Autopilot run <run-id>` that
  lists the rules below for that surface. Follow them for the rest of the
  command.
- **Autopilot with an owner gate set:** it refuses (exit 1) before anything is
  written. Stop: only the owner resolves an owner gate.
- **Interactive with an owner gate set:** it prints the gate, its pointer, how
  it is resolved, and the clear command. Put that to the user before the
  command continues.

A worker's scripts come from the installed plugin (`AGENTIC_ENGINEER_ROOT`),
while on a directory marketplace the command text can come from a newer
checkout. A script without these subcommands fails the Phase 0 line before any
write; the driver must also check that the installed engineer carries them
(ADR-0063, implementation note S3+S4).

## Ceremony gates auto-pass

| ceremony | interactive | autopilot |
|---|---|---|
| presentation-mode prompt (`presentation-protocol.md` § Offering the Choice) | ask once | do not ask; present in batch |
| "Recommended: X. Proceed?" | ask | proceed with X |
| decide: wait for the user to choose a direction | wait | no CONFLICT: the recommendation is the direction, at the synthesis's confidence |
| compose: plan approval, confirmation between code tasks | ask | the driver's: it runs the next step only on HIGH confidence |
| critique → refine MINOR / SUGGESTION pick (`/engineer:critique`) | the user picks | carry CRITICAL and MAJOR only |
| end-of-verb Active Next-Action Proposal | shown; the user runs the next command | still shown, and recorded as `next_step`; the driver decides |
| commit subject (`/engineer:commit`) | the user confirms | plan mode's suggested subject |

## What a step never does under autopilot

- **Write the terminal marker from a verb.** A verb ends with
  `state.mjs finish-verb`, which records the next step and turns the marker
  off (an inherited one too); `set-terminal --terminal-marker true` is refused.
  Only `/engineer:commit` closes a workflow.
- **Run `git commit` from a verb.** Record `next_step_kind=commit` when the
  artifact is ready; `/engineer:commit` commits. The driver also denies
  `git commit` on every other step.
- **Push, open or update a pull request, or take another outward action.**
  Record the `pr-handling` gate instead (below). Reading through `gh` inside a
  plugin script (`/orchestrator:done`'s landing check) is not an outward
  action, and neither is the "open and merge the pull request" next action
  Phase 7 writes after every commit: that is the owner's routine landing.
- **Clear an owner gate.** `awaiting-owner-clear` refuses.
- **Call `phase7-commit.mjs --mode execute` or `--mode close` directly.**
  Both refuse under autopilot; `--mode autopilot` runs them after its own
  checks.
- **Publish a next step with a peer still pending.** `finish-verb` refuses
  while `pending_ensemble` is non-empty.
- **Sleep-poll for a peer.** See Peer ensembles below.

## `next_step`

Every forward-decision verb (investigate, frame, decide, compose, critique,
refine) ends with `finish-verb`, whose flags are the closed-enum form of the
proposal's `selected_next` and `confidence`
(`entry-routing-contract.md` § Active Next-Action Proposal):

| `selected_next` | `--next-step-kind` | `--next-step-verb` |
|---|---|---|
| a verb | `verb` | that verb |
| `commit` | `commit` | — |
| `owner decision` | `owner-decision` | — |
| `done`: the deliverable is complete and produced nothing to commit | `done` | — |

`--next-step-confidence` is the proposal's confidence. The driver continues
only on `HIGH`. `commit` and `done` both route to `/engineer:commit`: it
commits what there is, and closes the workflow without a commit when the last
verb said `done` and nothing was ever committed. Phase 0 of every verb clears
the next step first, and each Phase 0 and Phase 2 write stops the block when
it fails, so a verb that stops before `finish-verb` leaves no next step, and
the driver halts rather than repeat the previous verb.

## Outcomes the driver reads

Once a workflow is terminal, its phase is the outcome and `next_step` is
history: it may still say `done`, `commit` or `owner-decision`.

| durable state | meaning |
|---|---|
| active, not terminal, commits may already exist | in progress, or an interrupted commit: `/engineer:commit` recovers it |
| archived, terminal, `commit-complete` | committed: check whether the pull request landed (ADR-0063 D3a) |
| archived, terminal, `close-complete` | closed without a commit: `/orchestrator:done <subtask> --no-commit` |
| active, terminal (`commit-complete` / `close-complete`) | the archive did not run yet (a failed Stop gate, or a close stopped before its archive): run `/engineer:commit` again |

## Owner gates

A genuine owner judgment stops the step. A verb records it with the phase
note the table names, then its last write:

```bash
# ARCHIVE TIMING — with an owner gate this write is never terminal, so the
# Stop hook, which fires at EVERY turn end on Claude, leaves the workflow
# active (it also refuses to archive while a gate is pending); the
# `--terminal-marker false` escape is not needed. On Codex the Stop hook runs
# only once the plugin hooks are trusted (`/hooks`).
node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" finish-verb \
  --workflow-path "$ACTIVE" --host "${AGENTIC_HOST:-claude}" \
  --next-action "<what the owner decides>" \
  --next-step-kind owner-decision --next-step-confidence "<HIGH|MEDIUM|LOW>" \
  --owner-gate <gate> --owner-gate-anchor <anchor>
```

That records the gate and the next step in one write and leaves the workflow
open: recording any gate turns an inherited terminal marker off. The Stop hook
never archives a workflow with a gate pending, not even once its branch is
gone, and `/engineer:commit` refuses to commit or close over one.

The gates, when each is set, the phase-note heading and anchor each takes,
and what resolves each are tabled once, in `entry-routing-contract.md` § Owner
gates. Under autopilot what differs is when a gate is recorded:
`decide-conflict`, `peer-conflict`, `recurring-finding` and `scope-routing`
are recorded in either mode; `staging-set` (`/engineer:commit`: the staging
set needs the owner — `ask_user`, a workflow that did not begin on a clean
tree, or a pre-staged index) and `pr-handling` only under an autopilot run.
A conflict gate (`decide-conflict` or `peer-conflict`, set on a synthesis
verdict of `conflict`) records its run id beside a consensus task file; the
driver's halt report carries the bounded consensus round it proposes, for the
owner to run (ADR-0067 Decision 8). No step runs it.

`awaiting-owner-clear --resolution "<the decision>" --next-step-kind …
--next-step-confidence … [--next-step-verb …] --next-action "<what comes next>"`
records the owner's decision, clears the gate, names the next step and
replaces the gate's `Owner: …` next action in one write. The next step is never
runnable without the decision behind it, and the `owner-decision` the gate
left does not stop the driver again. Every resolving block in these runbooks
does this, and resolves the workflow itself; inside an `/engineer:start`
lifecycle, decide's Owner selection records no next step instead
(`--clear-next-step true`), since the lifecycle owns its phase order.

**Anchors are labels.** A pointer's `#anchor` names the phase note with that
heading — the latest one when a workflow has several — not an HTML id (the
macro's `#macro-plan` / `#ensemble-synthesis` convention).

`/engineer:commit` never sets `pr-handling` for the commit it just made.
Landing a committed subtask is the owner's routine step: the driver reads it
from state (§ Outcomes the driver reads) and halts `awaiting-landing`.

`duplicate-workflow` is never stored: two live workflows on one branch have
no single file to hold it. The driver meets it as an entry-brief
`owner-choice-required` and halts `owner-choice`.

## Peer ensembles

Launch the peer runner **as a host background task** — on Claude, the Bash
tool's `run_in_background` — never behind a shell `&`, and collect it exactly
as `ensemble-protocol.md` § Step 2 says. The driver hosts each step over
stream-json: the session stays alive while a tracked background task is
pending, and the model is re-invoked when it completes. A shell `&` detaches
the runner where the host cannot see it, so the step would end before the
peer does. Wait for the notification; never sleep-poll a file or loop on
`sleep`.

**A report taken while you wait is provisional.** Under `claude -p` the host
takes the structured step report each time your turn ends, including a turn
you end to wait for a background task. That report does not end the step.
When the task's notification re-invokes you, carry on where the runbook left
off: collect the peer, synthesize, record the ensemble result (Phase 2's
`peer-runner.mjs settle`) and the verb's last write (`finish-verb`), then
end with a new report.
The driver judges the step by the last report only. A report you file
while still waiting says `failed` and names what it waits for, so a step
that never gets past it halts rather than passes. On the first two autopilot
runs of a real macro
(2026-10-04), workers took that first report as final and left the ensemble
unsettled.
