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

The note, and the two texts the block records with it, reach the scripts as
files, never in the block: in shell source a quote, `$`, backtick or line of
them would be read as code (ADR-0059, amendment of 2026-10-10). Before the
block:

1. Create a private directory for them, and note the path it prints:

   ```bash
   mktemp -d "${TMPDIR:-/tmp}/agentic-text.XXXXXX"
   ```

2. With your file-writing tool, not the shell, create in that directory
   `note.md`, the phase note above filled in; `summary.txt`, a one-line
   résumé of its breakdown; and `next-action.txt`, the next action the
   `append` and the last write record: the compact form of the proposal
   (selected_next + one-line why + next_command). The typical-case default
   is

   ```text
   {{next_action}}
   ```

   Write another when the verb's result selects a different next step, and
   for an owner gate below `Owner: ` and the judgment in a few words. Each
   file holds its text as written and ends with one newline, which the
   scripts remove; nothing deletes the files.

Then run the block with `TEXT_DIR` set to that directory, `RUN_ID` to the run
id the dispatch generated (empty when no run launched), and `VERDICT` to the
synthesis's verdict. A file left unwritten, blank, or not UTF-8 text stops the
block before any write.

`peer-runner.mjs settle` decides from the run ledger what the workflow
records, not from these values alone: a run that never launched records
nothing; a run that launched and failed, was cancelled or was abandoned
records verdict `failed` with the ledger's `error_kind`; a run that completed
records the synthesis verdict, or `degraded` when its answer was empty or
unreadable. An answer that parses to nothing usable, only structural
shell, reads to `settle` like any other, so set `VERDICT` to `degraded` then.
It refuses, and the block stops before the last write, while a run is still
live (collect it first) or when an empty `RUN_ID` would hide a run that
launched (set it to that run's id).

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
TEXT_DIR='<directory from step 1>'
ROOT_OVERRIDE="$(printenv {{root_env}} || true)"
CLAUDE_PLUGIN_ROOT="${ROOT_OVERRIDE:-${CLAUDE_PLUGIN_ROOT}}"
[ -n "$CLAUDE_PLUGIN_ROOT" ] || CLAUDE_PLUGIN_ROOT="$(find ~/.claude/plugins/cache/agentic-plugins/{{name}} -mindepth 1 -maxdepth 1 -type d 2>/dev/null | grep -E '/(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$' | sort -V | tail -1)"
# The run ledger lives under the repository root, where the dispatch put it.
REPO_ROOT="$(git rev-parse --show-toplevel)" || exit 1
# The texts the agent wrote with its file tool (ADR-0059, amendment of
# 2026-10-10): each script reads its file itself, so no line of the note is
# shell source. settle reads the summary only after the append has written,
# so each file is first held to every reader's rule: strict UTF-8, no NUL
# byte, and text left once blanks are trimmed (settle's rule). A file a
# script would refuse stops the block before any write.
for TEXT_FILE in note.md summary.txt next-action.txt; do
  node -e 'let t;try{t=new TextDecoder("utf-8",{fatal:true}).decode(require("fs").readFileSync(process.argv[1]))}catch{process.exit(1)}process.exit(t.includes("\0")||t.trim()===""?1:0)' "$TEXT_DIR/$TEXT_FILE" || { echo "✗ $TEXT_FILE in TEXT_DIR ($TEXT_DIR) is missing, blank or not UTF-8 text; write it with the file tool first. Nothing was written." >&2; exit 1; }
done

node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" append \
  --workflow-path "$ACTIVE" --host "${AGENTIC_HOST:-claude}" \
  --phase-label {{phase_label}} \
  --phase-note-file "$TEXT_DIR/note.md" \
  --current-phase phase-2-presented \
  --next-action-file "$TEXT_DIR/next-action.txt" \
  --event updated || exit $?

# ADR-0066 PC2b — settle the ensemble attempt from its ledger (never launched,
# launched and failed, completed); a refusal stops the block before the last
# write, so the workflow never closes with an attempt left unsettled.
node "$CLAUDE_PLUGIN_ROOT/scripts/peer-runner.mjs" settle \
  --repo-root "$REPO_ROOT" --workflow-path "$ACTIVE" \
  --host "${AGENTIC_HOST:-claude}" --phase {{verb}} --run-id "$RUN_ID" \
  --verdict "$VERDICT" --summary-file "$TEXT_DIR/summary.txt" || exit $?

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
  --next-action-file "$TEXT_DIR/next-action.txt" \
  --next-step-kind verb --next-step-verb {{next_verb}} \
  --next-step-confidence "<HIGH|MEDIUM|LOW>" || exit $?
# The owner-decision form, for an owner gate named above this block: it
# records the gate with the next step in one write, and the workflow stays
# open until the owner resolves the gate.
# node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" finish-verb \
#   --workflow-path "$ACTIVE" --host "${AGENTIC_HOST:-claude}" \
#   --next-action-file "$TEXT_DIR/next-action.txt" \
#   --next-step-kind owner-decision --next-step-confidence "<HIGH|MEDIUM|LOW>" \
#   --owner-gate '<gate>' --owner-gate-anchor '<anchor>' || exit $?
```
