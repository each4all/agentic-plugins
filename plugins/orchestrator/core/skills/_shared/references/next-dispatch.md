# `/orchestrator:next`: refusals, reruns and reasons

`commands/next.md` holds what a dispatch does when every phase passes. This
file holds the rest. Read a section when the state its heading names is the
one you see; a dispatch that runs through with no refusal needs none of it.

| What you see | Section |
|---|---|
| Phase 0 refused the arguments, or runs again with the same text directory | § Phase 0 refused the arguments, or runs again |
| `✗ Working tree not clean` (Phase 2) | § The working tree is not clean |
| A hold gate refused (Phase 1, 3, 3b or 4), Phase 3b's join refused, or a question about the admission or the dispatch's mark | § The admission and the dispatch's mark |
| Phase 5's `subtask-update` refused, or a re-attach refused a child | § The writeback or the re-attach was refused |
| You are editing a block and want to know why a line is there | § Why the blocks are as they are |

---

## Phase 0 refused the arguments, or runs again

A refused text (an unknown option, a second subtask id, a word holding a quote
or backslash) stops Phase 0 with the reason, and nothing is selected; the
parse removed the args file, so write a new one before running Phase 0 again.
Once Phase 0 has kept `arguments.json`, Phase 0 run again with the same text
directory reads it; a new args file there is parsed too, and refused unless it
names the same arguments: to run with other arguments, start again from step 1
with a new text directory. A rerun never selects by other arguments than the
kept ones without a word.

---

## The working tree is not clean

A dirty tree's refusal selects a worktree first (ADR-0067 Decision 8, item 3):
`state.mjs worktree-proposal` prints the `git worktree add` command for the
subtask's branch at `<parent>/<repo>-<slug>`, runtime:worktree's path, then the
`/orchestrator:next` to run again inside the new worktree. Its proposal is the
refusal's `selected_next`, with commit, stash or revert here among the rejected
alternatives (right when the changes are this subtask's or finished; wrong when
they are other work, which a switch would carry along). When the subtask's
branch is checked out in this very checkout and the subtask is in progress, the
changes are its engineer workflow's: the selection is the ordinary resume of
that workflow on this branch (`/engineer:resume`), and no worktree is
proposed. It proposes none, and says why, where a worktree cannot help
otherwise: the macro is in a linked worktree's own home, which no other
worktree reads (the state-root cutover, `docs/runbooks/state-root-cutover.md`,
makes a second worktree usable), or the subtask's branch is checked out here
for a subtask not yet in progress.

The clean check comes before any `git switch`: `/orchestrator:next` does not
switch branches over uncommitted changes, and the engineer's Phase 0
`status_digest` capture is meaningful only on a clean tree.

---

## The admission and the dispatch's mark

An autopilot run holds this checkout's worktree lock and its macro's lock
while it works. `/orchestrator:next` takes part in both, in the order the
driver takes them, as an **admission**: `admission join` writes one entry under
a random id in each, and refuses, naming the holder, when a run or another
session is there. A worker of the run that holds them passes with no entry and
an empty id. Then Phase 3b's block reads again what a run's step or a plan
revision could have changed before the join (the tree, the subtask branch's
engineer workflow, the selected subtask's status, engineer workflow id, branch,
verb, profile and topic, and for a pending subtask whether it still waits on
nothing) and switches. Every exit from the join until the switch has succeeded
releases the admission.

Before the switch it judges the hold gate again, under the holds lock, and,
for a subtask with no engineer workflow yet and a macro whose holds are on,
publishes the dispatch's **mark** (ADR-0068 Decision 2, item 5; N4): an
operation record of the lane that the engineer's bootstrap continues under the
id Phase 4 exports (`AGENTIC_OPERATION_ID`). A hold the owner sets from here on
waits for the dispatch to finish, so the command never records a subtask in
progress that its engineer then refuses. The block keeps the mark in the text
directory (`dispatch-mark.json`); every exit from its publication on withdraws
a mark no child carries (Phase 3b's block on a refusal, Phase 5's on every
path). A re-attach publishes none: the engineer's resume opens its own
operation, which the mark would refuse.

The hold gate itself (Phase 1, and again in Phases 3, 3b and 4): a held subtask
is never dispatched by hand, from whatever checkout the command runs in.
`state.mjs hold-gate` refuses a subtask whose hold is pending, held or cannot
be read, whose release no run has compared yet or was rejected, and one with a
persona operation open in its lane, naming the exit (the owner's
`agentic-autopilot release`, a run that compares the release, or `writer-clear`
for an operation whose session is gone). It only reads, and prints nothing for
a macro whose holds are not on. Phase 3's call adds the engineer's root: while
the macro's holds are on, the engineer the command dispatches into must be
hold-aware, since an older one writes terminal and leaves no operation a hold
would see.

Phase 5 sets the orchestrator's plugin root itself, as `$ORCH_PLUGIN_ROOT`,
and the host: in a fresh Bash call nothing Phase 4 set is left, and in the
shell of Phase 4's engineer call `$CLAUDE_PLUGIN_ROOT` names the engineer's
root until the block's opening line sets it back. Without them the check and
the release would fail, and the admission would stay in both locks, blocking
the macro until someone releases it by hand. Should one of the files the
release needs (`repo-root`, `macro-path`, `admission`) be gone, Phase 5 cannot
release an admission Phase 3b may have joined: the next join's refusal names
it, with the command that releases it.

---

## The writeback or the re-attach was refused

The admission keeps out a run and the other commands that join, not a plan
revision (`/orchestrator:plan` stays available, ADR-0067 Decision 4): Phase
3b's re-read catches one made before it, and the writeback's expectations one
made since; the child's recorded dispatch also refuses a re-attached child an
earlier dispatch made for the subtask as it was then. A refused writeback names
the field that changed. The child it would have bound was dispatched for the
subtask as Phase 1 read it, so it stays unrecorded: report the refusal and the
child's workflow id, and leave the choice to the user (archive the child with
`/engineer:resume archive <id>` on its branch and rerun `/orchestrator:next`,
or revise the plan back).

A change of only the subtask's `topic` or `profile` has a third exit: the owner
approves the revised plan with `/orchestrator:approve`, which rebinds the child
to the words approved and tells it the change (ADR-0068 Decision 8); the
re-attach then binds it. The refusal's `No rebinding applies: …` clause says
why it was not rebound: the plan is pending approval or changed since, the
approval rebound another child or other words, or the child has not been told
yet.

Whatever its dispatch, the re-attach also refuses a child the macro's record
cannot vouch for (ADR-0068 Decision 8, item 4):

- one a note to which is still pending (`has not been told the subtask's words
  yet`);
- one last told other words for the subtask (`was last told other words`);
- after an approval replaced an unreadable record of rebindings, one whose last
  words are not known (`what <child> was last told is not known`).

Its exits: deliver the note (a run does at the child's next boundary, or
`state.mjs rebind-deliver` now); approve the plan as it stands, which tells the
child the subtask's words (in full, when it replaced the record and can read
the child); or revise the plan back to the words the child was last told. An
archived child, which no note reaches, is completed by `/orchestrator:done
--waive-dispatch` with a reason, which the macro records.

A run asks the same check at the child's step boundary, of the child the step
would run (the recorded owner, or, when none is recorded, the child the run
selected): it does not step a child the check refuses (its lane parks, or a
serial run halts) and names the same exits. An approval tells only the child it
would rebind: when the subtask records no owner and several workflows claim it,
the refusal names recording the child its owner first (`subtask-update
--expect-dispatch`, which `/orchestrator:done` prints).

---

## Why the blocks are as they are

For someone editing `commands/next.md`; a dispatch never needs this section.

- **Phase 0, `--workflow=<id>`.** The id must be basename-shaped: a path
  component (`--workflow=../archive/<id>`) would let the macro path escape
  `workflows/` and name an archived or unrelated file (the same guard as
  `parent-writeback.mjs`'s). The `case` has no NUL pattern: a shell variable
  cannot hold NUL, and bash expands `$'\0'` to an empty string, which made the
  pattern match every id.
- **Phase 1, explicit id.** The block only checks that the id resolves; the
  absorbing-completed and terminal-partial preconditions of `subtask-update`
  reject a downgrade later. The validation block mirrors `next-ready`'s gate so
  an explicit id cannot bypass dependency ordering.
- **Phase 1, the approval gate.** It runs for an explicit id as well as for
  the automatic pick, because `subtask-readiness` reports no approval. It is
  given the subtask as selected, because that, not the plan the gate reads, is
  what Phases 4 and 5 dispatch.
- **JSON through `printf`, parsed whole.** A document goes through `printf`,
  not `echo`, whose zsh builtin (and a POSIX sh's) expands the backslash
  escapes inside JSON strings; the parse waits for the whole document, which a
  pipe hands over in chunks; and a document that does not parse fails the block
  rather than reading as nothing (C68).
- **`JSON_FIELD` takes its key from the environment.** Before any shell sees
  the command file, Claude replaces a dollar sign followed by a digit with the
  command's argument at that index (C67), so the key is never a positional
  parameter of the `node -e` source. For the same reason no comment in the file
  spells the host's argument placeholder.
- **A read and its parse are two commands.** Piped, a failed read would show
  only the parser's status: as a workflow with no parent, or a macro with no
  baseline branch (C110).
- **Phase 2, a recorded `engineer_workflow_id` with no active workflow.** The
  recorded child was archived, moved or deleted. A new bootstrap would land an
  unrelated id, and Phase 5's writeback would reject it as an ownership
  mismatch, leaving the user on the subtask branch with a stray active engineer
  workflow; so the block fails early. The ownership check leaves stderr alone,
  so a violation of the engineer's one-active-workflow-per-branch invariant
  (several workflow files on the branch, a corrupt file) reaches the output.
- **Phase 3b, the base of a new branch.** It starts from the integration
  branch (the macro's baseline branch) as the remote last reported it, never
  from the checked-out HEAD: after a squash or rebase merge, the previous
  subtask's branch is not part of the integration branch, and a successor built
  on it would carry obsolete history (ADR-0062 §Decision 2). The user lands on
  the subtask branch whether or not the command re-attached, since the
  engineer's resume keys on `git branch --show-current`.
- **Phase 4, the host.** The prelude infers the host from the orchestrator
  root's path shape (the Claude cache is under `~/.claude/`, the Codex cache
  under `~/.codex/`); a direct checkout falls back to `claude`, or to
  `AGENTIC_HOST` when it is set.
- **Phase 4, the exports.** `AGENTIC_PARENT_WORKFLOW_PATH` is the macro file's
  absolute path, which the engineer records beside the id and its writeback
  tries first, so a child whose own checkout holds no copy of the macro still
  reaches it (ADR-0067 Decision 3). `AGENTIC_DISPATCH_SELECTION` is the
  selection Phase 1 made, which every later binding of the child to the subtask
  (Phase 5, the engineer's terminal note, `/orchestrator:done`'s owner scan)
  compares under the macro's file lock (ADR-0067 Decision 4, item 5); it is
  built apart from its `export`, which would hide the `node` call's failure, so
  a selection lost there cannot create a child without the record.
  `AGENTIC_PROFILE` and `AGENTIC_TOPIC` carry the subtask's profile and topic:
  the engineer command's Phase 0 forwards them to `state.mjs create` in place
  of what a user would type, because the host fills the command's argument
  placeholder from typed text, not from the caller's environment.
- **Phase 5, what is recorded.** Only a dispatch whose check before the
  engineer passed is recorded, the holds on or off: a refused one is not (its
  refusal removes any earlier pass), nor one whose switch left no mark to
  check. The writeback is refused, under the macro's file lock, when a plan
  revision since Phase 1 changed the subtask's branch, verb, profile or topic,
  or when the subtask is no longer the one the child records it was dispatched
  for. From the writeback on, the driver's own claim rules see the subtask.
