Each phase boundary writes state via `state.mjs append --verb <verb>
--current-phase <phase> --next-action-file <file> --event updated` and
dispatches
the per-phase peer ensemble per
`core/skills/_shared/references/ensemble-protocol.md` (always-max). Every text
a write carries (a phase note, a next action, a summary, an owner's
decision) reaches `state.mjs` and `peer-runner.mjs` as a file: write it with
the file-writing tool into a private directory
(`mktemp -d "${TMPDIR:-/tmp}/agentic-text.XXXXXX"`) and pass the `-file`
form of its flag, never the text in a command (ADR-0059, amendment of
2026-10-10).

Inside the lifecycle each verb runs in place, so three rules hold at every
phase (ADR-0066 PC2b):

- **Each ensemble attempt is settled.** After its synthesis note, settle the
  phase's attempt from its run ledger with `peer-runner.mjs settle --phase
  <verb> --run-id <that attempt's run id>` (empty when no run launched) and
  its `--summary-file`, before
  the next phase. A repeated phase dispatches under a new run id. A refine
  that loops settles its passes in the refine skill: its pass settle (the
  **Each pass settles its own run** step) settles each earlier pass, launched
  or not, as the loop goes back, so the refine phase settles here the last
  pass's attempt only. Settling an earlier pass here as well would record a
  pass that launched no run twice, under two attempt keys. When no run launched for a phase whose
  ensemble is a review, the empty-id settle also names that review, by the
  type the phase's dispatch would have used (compose's `plan-verify`, or
  `review` where the compose skill picks the Review point type for code;
  critique's `review` or `adversarial-scan`; refine's `refine-verify`), and
  why it never ran: `--ensemble-type <that
  type> --no-run-reason <peer-unavailable|local-only|privacy-gate|owner-skip>
  --attempt-key <a new text directory for that settle>`, so the workflow records the
  review's attempt with its outcome (`unavailable` or `skipped`) and a rerun
  of that settle records it once (C163 A1a). A dispatch that launched takes
  `--subject-file <file>` (`{"shown": [...], "covered": [...]}`, the paths its
  prompt shows, and those at the content the tree holds now), and so does an
  empty-id settle for what the local reviewers read (ADR-0069 Decision 1). A `peer-runner.mjs` that does not name
  `--no-run-reason` in its usage predates the record: settle without those
  flags then.
- **No phase closes the workflow.** A verb's own terminal write
  (`finish-verb`) never runs inside the lifecycle; the lifecycle's last step
  below makes its one terminal write.
- **An owner gate pauses the lifecycle.** When a phase meets one (a decide
  CONFLICT, a recurring finding, a request that belongs elsewhere), record it
  after the phase note with `state.mjs awaiting-owner-set --gate <gate>
  --anchor <anchor>`, a write that leaves the workflow open, and pause. Once
  the owner decides, clear it with `state.mjs awaiting-owner-clear --gate
  <gate> --resolution-file <the owner's decision> --next-step-kind verb
  --next-step-verb <the next phase's verb> --next-step-confidence HIGH
  --next-action-file <the next phase's action>`, and continue at that phase. The
  verb's own resolving step (decide's Owner selection, refine's Owner
  decision), run inside the lifecycle, clears the gate and stops instead of
  making the verb's terminal write; resume the lifecycle from it. A
  synthesis verdict of `conflict` in decide, critique or investigate is such a
  gate (ADR-0067 Decision 8): once the settle has recorded it, write the
  contested items with the file tool to a new file, never into a command (they
  come from the peers' positions), and pass that file to
  `state.mjs consensus-task --workflow-path "$ACTIVE" --host "${AGENTIC_HOST:-claude}" --run-id <that run id> --text-file <that file>`,
  which prints the bounded consensus round to propose to the owner; then set
  `decide-conflict` (decide) or `peer-conflict` (critique, investigate) with
  `--anchor ensemble-synthesis --run-id <that run id>`.
