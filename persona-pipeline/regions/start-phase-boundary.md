Each phase boundary writes state via `state.mjs append --verb <verb>
--current-phase <phase> --next-action-file <file> --event updated` and
dispatches
the per-phase peer ensemble per
`core/skills/_shared/references/ensemble-protocol.md` (always-max). Every text
a write carries (a phase note, a next action, a summary, an owner's
decision) reaches `state.mjs` and `peer-runner.mjs` as a file, never the
text in a command (ADR-0059, amendment of 2026-10-10). At each phase, make the
phase's private text directory with this block, and note the path it prints:

```bash
# The phase's private text directory, marked so that the step that reads it
# last releases it (ADR-0059 Decisions 9 and 10).
ROOT_OVERRIDE="$(printenv {{root_env}} || true)"
CLAUDE_PLUGIN_ROOT="${ROOT_OVERRIDE:-${CLAUDE_PLUGIN_ROOT}}"
[ -n "$CLAUDE_PLUGIN_ROOT" ] || CLAUDE_PLUGIN_ROOT="$(find ~/.claude/plugins/cache/agentic-plugins/{{name}} -mindepth 1 -maxdepth 1 -type d 2>/dev/null | grep -E '/(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$' | sort -V | tail -1)"
MAKE_KIND='text'
MAKE_PARENT=''
{{> tmpdir-make}}
printf '%s\n' "$MADE_DIR"
```

With the file-writing tool, write each text of the phase's own writes into
it (the phase note, the next action, the settle's summary, an owner's
decision) and pass the `-file` form of its flag. The phase's dispatch is not
one of them: each dispatch, and each pass of a refine that loops, writes its
`prompt.xml` and `subject.json` in a directory of its own, made as the
ensemble protocol's launch step says, where the runner writes its result.
Each attempt's settle (the first rule below) is its dispatch directory's last
reader, so once that settle has succeeded, release the directory with this
block, a run launched or not; a settle that fails keeps it for the retry. A
phase that dispatches more than one ensemble (an investigate, a frame and a
decide in turn) runs it once per attempt, and a looping refine's pass settle
releases each earlier pass's directory itself, so here the refine phase's
last pass only (ADR-0059 Decision 10):

```bash
# The dispatch directory of the ensemble attempt whose settle succeeded.
DISPATCH_TEXT_DIR='<the dispatch directory of the attempt whose settle succeeded>'
ROOT_OVERRIDE="$(printenv {{root_env}} || true)"
CLAUDE_PLUGIN_ROOT="${ROOT_OVERRIDE:-${CLAUDE_PLUGIN_ROOT}}"
[ -n "$CLAUDE_PLUGIN_ROOT" ] || CLAUDE_PLUGIN_ROOT="$(find ~/.claude/plugins/cache/agentic-plugins/{{name}} -mindepth 1 -maxdepth 1 -type d 2>/dev/null | grep -E '/(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$' | sort -V | tail -1)"
case "$DISPATCH_TEXT_DIR" in
  ''|'<'*) echo "✗ DISPATCH_TEXT_DIR is empty or not filled in; nothing was released." >&2; exit 1 ;;
esac
# ADR-0059 Decision 10, item 1 — the attempt's settle succeeded: no block,
# rerun or continuation reads its dispatch directory again.
RELEASE_PATH="$DISPATCH_TEXT_DIR"
{{> tmpdir-release}}
```

Once the phase's last write has succeeded (its settle, its append, and an
owner gate's set or clear), release the phase's text directory with this
block; a write that fails keeps it for the retry:

```bash
TEXT_DIR='<the text directory of the phase>'
ROOT_OVERRIDE="$(printenv {{root_env}} || true)"
CLAUDE_PLUGIN_ROOT="${ROOT_OVERRIDE:-${CLAUDE_PLUGIN_ROOT}}"
[ -n "$CLAUDE_PLUGIN_ROOT" ] || CLAUDE_PLUGIN_ROOT="$(find ~/.claude/plugins/cache/agentic-plugins/{{name}} -mindepth 1 -maxdepth 1 -type d 2>/dev/null | grep -E '/(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$' | sort -V | tail -1)"
case "$TEXT_DIR" in
  ''|'<'*) echo "✗ TEXT_DIR is empty or not filled in; nothing was released." >&2; exit 1 ;;
esac
# ADR-0059 Decision 10, item 1 — the phase's last write succeeded: no block,
# rerun or continuation reads its text directory again.
RELEASE_PATH="$TEXT_DIR"
{{> tmpdir-release}}
```

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
  --attempt-key <the phase's text directory>`, so the workflow records the
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
