The phase note this step records — fill in every `<…>`. When no run launched
({{skip_cause}}; a run whose
companion is missing did launch, and settles `failed`), its first heading reads
`### Ensemble skipped: {{launched}} ({{skip_label}})` instead, and the synthesis
is local-only:

```markdown
### Ensemble launched: {{launched}} at <iso-utc>

### Ensemble synthesis: {{synthesis}} verdict=<{{verdicts}}>

<AGREED / LOCAL-ONLY / PEER-ONLY / CONFLICT breakdown>

{{artifact}}

### Active next-action proposal

(per `core/skills/_shared/references/entry-routing-contract.md` § Active Next-Action Proposal — derived from this artifact, not a fixed table)
- selected_next:         <verb | commit | done | owner decision>
- rejected_alternatives: <1-2 alternatives, each + one-line why-not>
- rationale:             <why best — {{rationale_gate}}>
- evidence_pointers:     <{{evidence_pointers}} — pointers only>
- confidence:            <HIGH | MEDIUM | LOW>
{{^capability commit_surface}}
- next_command:          <exact next step: /{{persona}}:<verb> … or ${{persona}}:<verb> for a verb; the owner's save and commit for commit; none for done; the owner's decision otherwise>
{{/capability}}
{{#capability commit_surface}}
- next_command:          <exact next step: /{{persona}}:<verb> … or ${{persona}}:<verb> for a verb; /{{persona}}:commit for commit or done; the owner-decision action otherwise>
{{/capability}}
```

Then run the block with the filled-in note in place of its placeholder line,
between the two `PHASE_NOTE` lines. The quoted heredoc hands the note to
`state.mjs` as written: no quote, `$`, backtick or backslash in it is read by
the shell. The first line that reads `PHASE_NOTE` alone ends the note, and
the shell runs every line after it as a command, so when the note itself holds
such a line, replace both `PHASE_NOTE` delimiters with a word no line of the
note consists of.

Set `RUN_ID` to the run id the dispatch generated, empty when no run launched,
and `VERDICT` and `SUMMARY` to the synthesis's verdict and a one-line résumé
of its breakdown. `peer-runner.mjs settle` decides from the run ledger what the
workflow records, not from these values alone: a run that never launched
records nothing; a run that launched and failed, was cancelled or was
abandoned records verdict `failed` with the ledger's `error_kind`; a run that
completed records the synthesis verdict, or `degraded` when its answer was
empty or unreadable. An answer that parses to nothing usable, only structural
shell, reads to `settle` like any other, so set `VERDICT` to `degraded` then.
It refuses, and the block stops before the last write, while a run is still
live (collect it first) or when an empty `RUN_ID` would hide a run that
launched (set it to that run's id).

A synthesis verdict of `conflict` ends this verb on its conflict gate,
`{{conflict_gate}}`, with a bounded consensus round proposed before the
owner decides (ADR-0067 Decision 8). The proposal's `selected_next` is the
owner decision, after a bounded consensus round; its `rejected_alternatives`
include "the owner decides now", with the reason for this case (what the two
positions leave unweighed that a round between the peers would weigh); and its
`next_command` is `/runtime:consensus plan --task-file <the task file> --peers
claude,codex --max-rounds 2`, two rounds at most. In the phase note the task
file is spelled from the state root,
`.agentic-plugins/state/{{persona}}/consensus/<workflow id>.<run id>.md`; the
completion output gives the command the block prints, with its absolute
path.

The block branches on the verdict the settle recorded for the run, not on
`VERDICT` alone. Recorded `conflict`, with `VERDICT` set to `conflict`, it
writes the contested items to that task file (`consensus-task`), then records
the gate with the run id in the same write as the next step `owner-decision`.
Write the contested items only then, with the file tool, to a new file, and
set `CONTESTED_FILE` to its path: each CONFLICT item with both positions and
their evidence, prepared as the peer prompt was, since the consensus peers
read it. They come from the peers' positions, so never put them in the block:
there the shell would read a line of them as a command. When the recorded
verdict and `VERDICT` disagree (a run recorded `failed`, or a conflict
recorded by an earlier attempt), the block stops before the last write: set
`VERDICT` to the recorded verdict, and `CONTESTED_FILE` too when that is
`conflict`, and run the block again. Its settle does nothing for a run it
already recorded, so the branch that matches runs: on a conflict,
`consensus-task` first, then the gate. Nothing runs the consensus round: the
owner does, then rules, and clearing the gate retires the task file. compose,
frame and refine, and every other verdict, never take this branch.

The last write, `finish-verb`, records the proposal's next step in closed-enum
{{^capability commit_surface}}
form: `--next-step-kind` `verb` (with `--next-step-verb`), `commit` (the owner
saves and commits the artifact; {{persona}} runs no commit itself) or `done`,
each closing the workflow `summary-complete`. End instead with an owner gate
when the owner must judge, with the judgment under the gate's heading in the
note:
{{/capability}}
{{#capability commit_surface}}
form: `--next-step-kind` `verb` (with `--next-step-verb`), `commit`
(`/{{persona}}:commit` commits the change, or closes the workflow when there is
none) or `done`, each closing the workflow `summary-complete`.
{{/capability}}
{{#capability dispatch_target}}
Under an autopilot run it records the next step only and leaves the terminal
marker for `/{{persona}}:commit`, the only command that closes a workflow
there (`core/skills/_shared/references/autopilot-mode.md`).
{{/capability}}
{{#capability commit_surface}}
End instead with an owner gate when the owner must judge, with the judgment
under the gate's heading in the note:
{{/capability}}

{{owner_gates}}
{{#capability dispatch_target}}
- `pr-handling` (heading `### Outward action needed`, anchor `pr-handling`):
  under an autopilot run, the task itself needs a push, a pull request or
  another outward action; interactively the user acts instead.
{{/capability}}

The owner-decision form below records the gate with the next step in one
write and leaves the workflow open, not terminal, until the owner resolves it.

```bash
ROOT_OVERRIDE="$(printenv {{root_env}} || true)"
CLAUDE_PLUGIN_ROOT="${ROOT_OVERRIDE:-${CLAUDE_PLUGIN_ROOT}}"
[ -n "$CLAUDE_PLUGIN_ROOT" ] || CLAUDE_PLUGIN_ROOT="$(find ~/.claude/plugins/cache/agentic-plugins/{{name}} -mindepth 1 -maxdepth 1 -type d 2>/dev/null | grep -E '/(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$' | sort -V | tail -1)"
# The run ledger lives under the repository root, where the dispatch put it.
REPO_ROOT="$(git rev-parse --show-toplevel)" || exit 1
# Where read takes no -d (dash) it assigns nothing, so clear NOTE first: a
# value the shell inherited must not stand in for the note.
unset NOTE
IFS= read -r -d '' NOTE <<'PHASE_NOTE' || true
<the phase note above, filled in>
PHASE_NOTE
# A shell whose read has no -d (dash) reads nothing: stop before any write.
[ -n "$NOTE" ] || { echo "✗ No phase note was read; nothing was written." >&2; exit 1; }

node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" append \
  --workflow-path "$ACTIVE" --host "${AGENTIC_HOST:-claude}" \
  --phase-label {{phase_label}} \
  --phase-note "$NOTE" \
  --current-phase phase-2-presented \
  --next-action {{next_action}} \
  --event updated || exit $?

# ADR-0066 PC2b — settle the ensemble attempt from its ledger (never launched,
# launched and failed, completed); a refusal stops the block before the last
# write, so the workflow never closes with an attempt left unsettled.
node "$CLAUDE_PLUGIN_ROOT/scripts/peer-runner.mjs" settle \
  --repo-root "$REPO_ROOT" --workflow-path "$ACTIVE" \
  --host "${AGENTIC_HOST:-claude}" --phase {{verb}} --run-id "$RUN_ID" \
  --verdict "$VERDICT" --summary "$SUMMARY" || exit $?

# ADR-0067 Decision 8 — the verdict the settle above recorded for the run
# (empty when it recorded none). A recorded conflict does not close the
# verb: it writes the contested items as the consensus task file and ends on
# the conflict gate, bound to its run. Any other verdict makes the typical
# last write.
RECORDED="$(node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" ensemble-verdict \
  --workflow-path "$ACTIVE" --run-id "$RUN_ID")" || exit $?
if [ "$RECORDED" != conflict ] && [ "$VERDICT" != conflict ]; then
  # ADR-0029 §1 / completion-output contract §2 — set --next-action (the
  # append above and this terminal write) to the COMPACT form of the
  # proposal above (selected_next + one-line why + next_command) so the
  # durable state and the code-emitted completion footer agree with the
  # Active Next-Action Proposal. The value shown is the typical-case
  # default; override it, and the --next-step-* flags, when the verb's result
  {{^capability commit_surface}}
  # selects a different next step (e.g. the owner's save and commit).
  {{/capability}}
  {{#capability commit_surface}}
  # selects a different next step (e.g. commit).
  {{/capability}}
  # ADR-0063 D3 — finish-verb is the verb's last write: the ADR-0017
  # §sub-decision 5 atomic terminal write (summary-complete + terminal marker)
  {{^capability dispatch_target}}
  # with the next step. ADR-0066 Decision 3: an inherited AGENTIC_AUTOPILOT
  # changes nothing here.
  {{/capability}}
  {{#capability dispatch_target}}
  # with the next step, interactively. Under an autopilot run (ADR-0066
  # Decision 3: AGENTIC_AUTOPILOT names a run, on Claude) it writes the next step
  # only and leaves the terminal marker for the commit command, which alone
  # closes a workflow there.
  {{/capability}}
  # ARCHIVE TIMING — on Claude the Stop hook fires at EVERY turn end, so the
  # archive gates are evaluated at the end of THIS turn, not at session close;
  # if a gate fails the workflow stays marked and a later Stop re-evaluates it.
  # Clearing the marker with `--terminal-marker false` works only before that
  # Stop fires, needs set-terminal's full flag set (--workflow-path, --host,
  # --terminal-phase), and does not restore the previous phase or next_action.
  # On Codex the Stop hook runs only once the operator has trusted the plugin
  # hooks (`/hooks`), so evaluation waits for that. Full contract:
  # core/skills/_shared/references/session-handoff.md § Archive timing.
  node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" finish-verb \
    --workflow-path "$ACTIVE" --host "${AGENTIC_HOST:-claude}" \
    --next-action {{next_action}} \
    --next-step-kind verb --next-step-verb {{next_verb}} \
    --next-step-confidence "<HIGH|MEDIUM|LOW>" || exit $?
elif [ "$RECORDED" != conflict ] || [ "$VERDICT" != conflict ]; then
  echo "✗ The synthesis verdict is ${VERDICT:-unset}, but run ${RUN_ID:-<none>} is recorded with ${RECORDED:-no verdict}: a consensus round needs both to be conflict. Set VERDICT to the recorded verdict (and CONTESTED_FILE when that is conflict) and run this block again: its settle does nothing for a recorded run, and the matching branch runs, consensus-task first on a conflict. Nothing more was written." >&2
  exit 1
else
  # The contested items, from the file CONTESTED_FILE names, written with the
  # file tool: the shell never reads them, so no line of them runs as a
  # command. No file named stops the block before the gate; consensus-task
  # refuses an empty one.
  [ -n "${CONTESTED_FILE:-}" ] || { echo "✗ CONTESTED_FILE names no file of contested items; the gate was not recorded." >&2; exit 1; }
  # The task file, once the settle above recorded the run with the verdict
  # conflict; it prints the consensus round the proposal selects.
  PROPOSED="$(node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" consensus-task \
    --workflow-path "$ACTIVE" --host "${AGENTIC_HOST:-claude}" --run-id "$RUN_ID" \
    --text-file "$CONTESTED_FILE")" || exit $?
  # The gate, bound to its run, and the next step owner-decision in one
  # write: the workflow stays open until the owner rules.
  # ARCHIVE TIMING — with an owner gate this write is never terminal, so the
  # Stop hook, which fires at EVERY turn end on Claude, leaves the workflow
  # active (it refuses to archive while a gate is pending); the
  # `--terminal-marker false` escape is not needed. On Codex the Stop hook runs
  # only once the plugin hooks are trusted (`/hooks`).
  node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" finish-verb \
    --workflow-path "$ACTIVE" --host "${AGENTIC_HOST:-claude}" \
    --next-action "Owner decision, after a bounded consensus round: $PROPOSED" \
    --next-step-kind owner-decision --next-step-confidence "<HIGH|MEDIUM|LOW>" \
    --owner-gate {{conflict_gate_word}} --owner-gate-anchor ensemble-synthesis \
    --owner-gate-run-id "$RUN_ID" || exit $?
  echo "→ Proposed, for the owner to run before deciding: $PROPOSED" >&2
fi
# The owner-decision form, for an owner gate named above this block: it
# records the gate with the next step in one write, and the workflow stays
# open until the owner resolves the gate.
# node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" finish-verb \
#   --workflow-path "$ACTIVE" --host "${AGENTIC_HOST:-claude}" \
#   --next-action '<Owner: the judgment, in a few words>' \
#   --next-step-kind owner-decision --next-step-confidence "<HIGH|MEDIUM|LOW>" \
#   --owner-gate '<gate>' --owner-gate-anchor '<anchor>' || exit $?
```
