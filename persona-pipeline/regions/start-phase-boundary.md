Each phase boundary writes state via `state.mjs append --verb <verb>
--current-phase <phase> --next-action <...> --event updated` and dispatches
the per-phase peer ensemble per
`core/skills/_shared/references/ensemble-protocol.md` (always-max).

Inside the lifecycle each verb runs in place, so three rules hold at every
phase (ADR-0066 PC2b):

- **Each ensemble attempt is settled.** After its synthesis note, settle the
  phase's attempt from its run ledger with `peer-runner.mjs settle --phase
  <verb> --run-id <that attempt's run id>` (empty when no run launched), before
  the next phase. A repeated phase (a second refine pass) dispatches under a
  new run id and settles each attempt.
- **No phase closes the workflow.** A verb's own terminal write
  (`finish-verb`) never runs inside the lifecycle; the lifecycle's last step
  below makes its one terminal write.
- **An owner gate pauses the lifecycle.** When a phase meets one (a decide
  CONFLICT, a recurring finding, a request that belongs elsewhere), record it
  after the phase note with `state.mjs awaiting-owner-set --gate <gate>
  --anchor <anchor>`, a write that leaves the workflow open, and pause. Once
  the owner decides, clear it with `state.mjs awaiting-owner-clear --gate
  <gate> --resolution <the owner's decision> --next-step-kind verb
  --next-step-verb <the next phase's verb> --next-step-confidence HIGH
  --next-action <the next phase's action>`, and continue at that phase. The
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
