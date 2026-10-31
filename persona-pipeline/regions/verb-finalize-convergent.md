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

   When the re-critique did not converge (below), `next-action.txt` holds the
   flagged item and the next step that resolves it.

Then run the block with `TEXT_DIR` set to that directory, `DISPATCH_DIR` to the
directory the dispatch block ran with, `VERDICT` to the synthesis's verdict,
and `CONFIDENCE` to the proposal's confidence (`HIGH`, `MEDIUM` or `LOW`). The block reads the run's id from the result the runner wrote there,
`prompt.xml.run.json`, never from a value carried from the dispatch's shell. A
runner that ended without writing its result (killed, or stopped by an error
after it launched the run) leaves that file empty: the block then takes the run
from `prompt.xml.dispatch.json`, which the dispatch block wrote there before
the launch, naming the run and the workflow. A run whose handle or record names
another workflow than the one the block finds, a handle that cannot be read
as that run's (one gone is left to the dispatch's record), or a directory
with no result, or one naming no well-formed run id, stops the block before
any write; settle, its first write, refuses a run of another phase. A
well-formed run id is one the runner accepts: letters, digits, `.`, `_`, `:`
and `-`, with no `..`, so a run the runner launched can always be finalized.

When no run launched (the verb ran local-only, or the dispatch's
`prompt.xml.err` says why), leave `DISPATCH_DIR` empty: that is the empty id,
"no run launched", and settle refuses it while the workflow holds a run of
this phase it would hide. When a run launched but its dispatch's directory is
gone (a later session, or a system that cleared its temporary files), set
`DISPATCH_DIR` to the run's own ledger directory, the one holding the
`envelope.json` the synthesis read
(`.agentic-plugins/state/{{persona}}/peer-runs/<run id>`): the block reads the
run from its `handle.json` and checks it as it checks a dispatch's, the
workflow here and the phase in settle, so the run settled is always the one
the synthesis read, never one chosen from the workflow's pending entries. With
neither directory left, nothing binds the run to the synthesis: the block
cannot settle it, and settle does by hand (`peer-runner.mjs settle --run-id`).

Whatever run the block settles, the empty id included, it keeps in its text
directory as `finalize-run.json` before settle. Every value the last write
takes is checked before settle too (`CONFIDENCE` here), so a step that fails
after it fails on the workflow's own state, and its message says what. Run
again with the same `TEXT_DIR` after a later step failed, it settles that same
run again, which records nothing more; a phase note the failed run already
appended (the failure came at the last write) is appended a second time. A kept run that differs from the one this run of the
block names stops it before any write: each finalize takes a fresh text
directory, and a record left by another stays its own. The empty id binds
too: after settle refuses it (a run of this phase is pending), collect that
run, synthesize it, and finalize it from a fresh text directory. A file left
unwritten, blank, or not UTF-8 text stops it too.

`peer-runner.mjs settle` decides from the run ledger what the workflow
records, not from these values alone: a run that never launched records
nothing; a run that launched and failed, was cancelled or was abandoned
records verdict `failed` with the ledger's `error_kind`; a run that completed
records the synthesis verdict, or `degraded` when its answer was empty or
unreadable. An answer that parses to nothing usable, only structural
shell, reads to `settle` like any other, so set `VERDICT` to `degraded` then.
It runs before the block writes anything, so its refusal leaves the workflow
as it was: while a run is still live, or its handle was last updated less than
the stale grace (a minute) ago (collect it, or wait, and run the block again); for a run of
another workflow or phase; or when an empty id would hide an attempt the
ledger holds for this phase (collect that run and synthesize it, then set
`DISPATCH_DIR` to its directory, or to its ledger directory when that is
gone). Once
it has recorded a run, running the block again records nothing more for it.

This verb closes only once it converged (`terminal_requires_convergence`).
Set `CONVERGED` in the block to `yes` only when the re-critique converged by
the convergence rule above; anything else, an unset value included, reads as
not converged. Converged, the last write is `finish-verb`. Not converged, the
last write is an `append` that records the next step resolving the flagged
item, `RESOLVE_VERB` in the block (`refine`, `decide` or `investigate`), and
turns off a terminal marker an earlier verb left, so the workflow stays open
and the Stop hook cannot archive it; its `next-action.txt` is the one step 2
describes for that case. Not converged, a `RESOLVE_VERB` left unfilled stops
the block before any write. An owner gate named in `OWNER_GATE`, where the
block has one, is the last write either way.

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
{{#capability dispatch_target}}

Set `OP_DIR` to the operation directory the Phase 0 bootstrap or resume block
printed (`OP_DIR=<path>`), or leave it empty when it printed none: the last
write, `finish-verb` (or, where this block has one, the write that keeps the
workflow open), closes there the persona operation Phase 0 opened when the
workflow is a macro's child (ADR-0068 Decision 2, item 7). A value left
unfilled stops the block before any write.

**The verify form** (ADR-0068 Decision 5). Under an autopilot run that offers
verification (Phase 0's preflight banner says so: `This run offers
verification`), the long checks this verb's change
needs are not run in its step: the driver runs them, with no LLM, after the
step ends (§ Long checks in `/{{persona}}:compose`, `/{{persona}}:refine` and
`/{{persona}}:critique` says which are long).
To hand them over, write `verify-request.json` in the text directory with your
file-writing tool before the block; the block then ends with the next step
`verify` and the request, in place of the verb form. The request is JSON: an
ordered list of `checks`, each a `kind` the repository declares
(`.agentic-plugins/verify-checks.json` at the run's baseline) with its `args`
as data (the files of the tested tree a check names, a mutation spec and its
case ids); `on_pass`, the next step once every check passed on the unchanged
tree (`verb` with its `verb`, `commit` or `done`, and its confidence); and
`confidence`, which is the proposal's and `CONFIDENCE`'s. For example:

```json
{
  "checks": [
    { "kind": "test", "args": { "files": ["tests/persona-pipeline/test-verify-record.mjs"] } },
    { "kind": "mutate", "args": { "spec": "scripts/mutation-specs/verify-runbooks.mjs", "ids": ["K1", "F1"] } }
  ],
  "on_pass": { "kind": "verb", "verb": "critique", "confidence": "HIGH" },
  "confidence": "HIGH"
}
```

Then `next-action.txt` names the verification (for example `Verify: the
changed tests and the mutation cases, then critique`). When every check
passed, the driver dispatches `on_pass`; otherwise it resumes this verb, whose
Phase 0 prints the results. The block checks the request before its first
write with the last write's own checks (`state.mjs verify-request-check`), so
a request it would refuse (a run that offers no verification, a kind not
declared, a path not in the tree, a confidence that is not `CONFIDENCE`)
stops it with nothing written: fix the request, or remove the file to end
with the verb form. A conflict takes no request, and neither does any other
owner gate: a step that ends on its owner's judgment writes no
`verify-request.json`, since the driver would otherwise run the checks and
then `on_pass` past the judgment. Set `OWNER_GATE` in the block to the gate
whenever the step ends on one: the last write is then the owner-decision
form, which records that gate with the anchor the gate list above names, in
place of the verb or verify form. A gate this verb does not end on with it, a
request beside it, and a note that holds the heading of `recurring-finding`,
`scope-routing` or `pr-handling` while `OWNER_GATE` is empty each stop the
block before any write. Once every other check has passed, just before
settle, the block keeps the form it took in the text directory
(`finalize-verify.json`: the request's sha256, or none), so a run those checks
stop keeps none and may add a request: run again with the same `TEXT_DIR`
after a write, it takes the same form and the same request, and a request
added, removed or changed since stops it before any write. With no `verify-request.json`, the block ends with the verb form as
always.
{{/capability}}

```bash
TEXT_DIR='<directory from step 1>'
DISPATCH_DIR='<the directory the dispatch block ran with; empty when no run launched; the run ledger directory when a run launched and that directory is gone>'
VERDICT='<the synthesis verdict>'
CONFIDENCE='<HIGH|MEDIUM|LOW>'
# The convergence, fail-closed: shell state does not survive between Bash
# calls, so an unset CONVERGED reads as not converged, never as success.
# Assign it here, from the re-critique verdict, and, not converged, the next
# step that resolves the flagged item.
CONVERGED="<yes|no — from the re-critique verdict; unset means no>"
RESOLVE_VERB='<refine|decide|investigate — the next step that resolves the flagged item, when not converged>'
{{#capability dispatch_target}}
OP_DIR='<the operation directory the Phase 0 block printed as OP_DIR; empty when it printed none>'
# The owner gate this step ends on, when it ends on one; empty otherwise.
# Naming it selects the last write's owner-decision form, which records it.
OWNER_GATE=''
{{/capability}}
ROOT_OVERRIDE="$(printenv {{root_env}} || true)"
CLAUDE_PLUGIN_ROOT="${ROOT_OVERRIDE:-${CLAUDE_PLUGIN_ROOT}}"
[ -n "$CLAUDE_PLUGIN_ROOT" ] || CLAUDE_PLUGIN_ROOT="$(find ~/.claude/plugins/cache/agentic-plugins/{{name}} -mindepth 1 -maxdepth 1 -type d 2>/dev/null | grep -E '/(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$' | sort -V | tail -1)"
# A fresh shell: the workflow and the run are found again here, never carried
# from an earlier block. The run ledger lives under the repository root, where
# the dispatch put it.
PERSONA={{name}}
REPO_ROOT="$(git rev-parse --show-toplevel)" || exit 1
ACTIVE="$(node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" find-active --repo-root "$REPO_ROOT")" || exit $?
[ -n "$ACTIVE" ] || { echo "✗ No active ${PERSONA} workflow on this branch; nothing was written." >&2; exit 1; }
{{#capability dispatch_target}}
case "$OP_DIR" in
  *'<'*) echo "✗ OP_DIR is not set to the operation directory Phase 0 printed (empty when it printed none); nothing was written." >&2; exit 1 ;;
esac
{{/capability}}
case "$VERDICT" in
  ''|*'<'*) echo "✗ VERDICT is not set to the synthesis verdict; nothing was written." >&2; exit 1 ;;
esac
# The last write's confidence, checked here with the other values it takes, so
# a value it would refuse stops the block before settle, its first write.
case "$CONFIDENCE" in
  HIGH|MEDIUM|LOW) ;;
  *) echo "✗ CONFIDENCE is not HIGH, MEDIUM or LOW, the proposal's confidence the last write records; nothing was written." >&2; exit 1 ;;
esac
# Not converged, the last write records RESOLVE_VERB as the next step: checked
# here as well.
if [ "${CONVERGED:-no}" != "yes" ]; then
  case "$RESOLVE_VERB" in
    refine|decide|investigate) ;;
    *) echo "✗ CONVERGED is not yes, and RESOLVE_VERB is not refine, decide or investigate, the next step that resolves the flagged item; nothing was written." >&2; exit 1 ;;
  esac
fi
{{#capability dispatch_target}}
# The owner gate selects the last write's owner-decision form, with the anchor
# the gate list names; a gate this verb does not end on with it stops the block
# here, before settle, its first write. A note holding a gate's heading names
# a gate too: with OWNER_GATE empty the verb form would close the step past
# the owner's judgment, so it stops the block as well. A heading indented by up
# to three spaces, or with more than one space or a tab after its ###, is still
# one (CommonMark); one quoted in a fenced example
# matches too, a limit that fails closed (the block stops, nothing written).
OWNER_GATE_ANCHOR=''
case "$OWNER_GATE" in
  '') ;;
  scope-routing) OWNER_GATE_ANCHOR=routing-recommendation ;;
  pr-handling) OWNER_GATE_ANCHOR=pr-handling ;;
  recurring-finding) [ {{verb}} != refine ] || OWNER_GATE_ANCHOR=recurring-finding ;;
  decide-conflict) [ {{verb}} != decide ] || OWNER_GATE_ANCHOR=ensemble-synthesis ;;
esac
[ -z "$OWNER_GATE" ] || [ -n "$OWNER_GATE_ANCHOR" ] \
  || { echo "✗ OWNER_GATE is $OWNER_GATE, which is not a gate this verb ends on with the owner-decision form (the gate list above names them); nothing was written." >&2; exit 1; }
[ -n "$OWNER_GATE" ] || ! grep -Eq '^ {0,3}###[[:blank:]]+(Recurring finding|Routing recommendation|Outward action needed)([[:space:]]|$)' "$TEXT_DIR/note.md" 2>/dev/null \
  || { echo "✗ note.md in TEXT_DIR ($TEXT_DIR) records an owner gate (its heading), but OWNER_GATE is empty: set OWNER_GATE to that gate, and the last write records it. Nothing was written." >&2; exit 1; }
{{/capability}}
# The run's id, from the result the runner wrote beside the dispatch's prompt,
# or, when DISPATCH_DIR is the run's own ledger directory (no result there,
# its handle.json instead), from that handle, the directory naming the run. An empty
# DISPATCH_DIR (exit 5) is the empty id, no run launched; nothing else stands
# for a run, and none is chosen from the workflow's pending entries. A result
# that is missing or names no well-formed run id (the runner's rule: letters,
# digits, ".", "_", ":" and "-", with no "..", so every run it launched can be
# finalized) stops it, as does a
# run whose handle names another workflow than the one found above (exit 2)
# or cannot be read as the run's (exit 3): nothing is written to a workflow
# the run is not for; settle, the first write, judges the phase. Exit 4 leaves the run to the
# dispatch's own record: a result left empty, or a run whose handle is gone
# (its id printed).
RUN_ID="$(node -e 'const [d,w]=process.argv.slice(1);if(d==="")process.exit(5);const fs=require("fs"),p=require("path");const good=(v)=>typeof v==="string"&&/^[A-Za-z0-9._:-]+$/.test(v)&&!v.includes("..");const same=(a,b)=>{try{return fs.realpathSync(a)===fs.realpathSync(b)}catch{return p.resolve(a)===p.resolve(b)}};const bound=(h,id)=>{if(h===null||typeof h!=="object"||h.run_id!==id)process.exit(3);if(typeof h.workflow_path!=="string"||!same(h.workflow_path,w))process.exit(2);process.stdout.write(id);process.exit(0)};let t,r,h;try{t=fs.readFileSync(p.join(d,"prompt.xml.run.json"),"utf8")}catch(e){if(!(e&&e.code==="ENOENT"))process.exit(1);try{h=fs.readFileSync(p.join(d,"handle.json"),"utf8")}catch(e){process.exit(e&&(e.code==="ENOENT"||e.code==="ENOTDIR")?1:3)}const id=p.basename(p.resolve(d));if(!good(id))process.exit(1);try{h=JSON.parse(h)}catch{process.exit(3)}bound(h,id)}if(t.trim()==="")process.exit(4);try{r=JSON.parse(t)}catch{process.exit(1)}const id=r&&r.run_id;if(!good(id))process.exit(1);try{h=fs.readFileSync(r.handle_path,"utf8")}catch(e){if(e&&e.code==="ENOENT"){process.stdout.write(id);process.exit(4)}process.exit(3)}try{h=JSON.parse(h)}catch{process.exit(3)}bound(h,id)' "$DISPATCH_DIR" "$ACTIVE")"
RUN_READ=$?
if [ "$RUN_READ" -eq 2 ]; then
  echo "✗ The run in DISPATCH_DIR ($DISPATCH_DIR) is not one of $ACTIVE: its handle names another workflow, or none (a peer-now or manual run, dispatched for no workflow); nothing was written. Finalize on the branch whose workflow the dispatch ran for; a run dispatched for no workflow is not this finalize's to settle." >&2
  exit 1
elif [ "$RUN_READ" -eq 3 ]; then
  echo "✗ The handle of the run in DISPATCH_DIR ($DISPATCH_DIR) cannot be read as that run's, so the run cannot be bound to $ACTIVE; nothing was written." >&2
  exit 1
elif [ "$RUN_READ" -eq 4 ]; then
  # The dispatch recorded, before the launch, the run it launches and the
  # workflow it found (prompt.xml.dispatch.json): that run is the one to
  # settle, for the workflow found above only. A run the result names, its
  # handle gone, must be that same run.
  RUN_ID="$(node -e 'const [d,w,named]=process.argv.slice(1);const fs=require("fs"),p=require("path");const same=(a,b)=>{try{return fs.realpathSync(a)===fs.realpathSync(b)}catch{return p.resolve(a)===p.resolve(b)}};let m;try{m=JSON.parse(fs.readFileSync(p.join(d,"prompt.xml.dispatch.json"),"utf8"))}catch{process.exit(1)}const id=m&&m.run_id;if(typeof id!=="string"||!/^[A-Za-z0-9._:-]+$/.test(id)||id.includes("..")||(named!==""&&named!==id))process.exit(1);if(typeof m.workflow_path!=="string"||!same(m.workflow_path,w))process.exit(2);process.stdout.write(id)' "$DISPATCH_DIR" "$ACTIVE" "$RUN_ID")"
  case $? in
    0) ;;
    2) echo "✗ The run in DISPATCH_DIR ($DISPATCH_DIR) was dispatched for another workflow than $ACTIVE; nothing was written. Finalize on the branch whose workflow the dispatch ran for." >&2; exit 1 ;;
    *) echo "✗ The runner left no usable result in DISPATCH_DIR ($DISPATCH_DIR), and prompt.xml.dispatch.json there is missing, malformed or names another run; nothing was written. When the run launched, set DISPATCH_DIR to its ledger directory, the one holding the envelope.json the synthesis read, and run this block again; with no ledger directory either, settle the run by hand (peer-runner.mjs settle --run-id), then run this block with DISPATCH_DIR empty from a fresh TEXT_DIR. When the runner refused before any ledger (prompt.xml.err says why), no run launched: leave DISPATCH_DIR empty." >&2; exit 1 ;;
  esac
elif [ "$RUN_READ" -eq 5 ]; then
  # No run launched: the empty id (the read printed nothing), which settle
  # accepts only when no attempt of this phase is open. It never stands for a
  # run whose directory is gone.
  :
elif [ "$RUN_READ" -ne 0 ]; then
  echo "✗ prompt.xml.run.json in DISPATCH_DIR ($DISPATCH_DIR) is missing or names no well-formed run id, and DISPATCH_DIR is no run ledger directory; nothing was written. Set DISPATCH_DIR to the directory the dispatch block ran with; leave it empty when no run launched (prompt.xml.err there says why), or, when a run launched and that directory is gone, set it to the run's ledger directory, the one holding the envelope.json the synthesis read." >&2
  exit 1
fi
# The run this block settles is kept in TEXT_DIR (finalize-run.json) before
# settle; the empty id is kept too. Run again after a later step failed, the
# block settles the same run: a run kept that differs from the one named now,
# the empty id included (exit 3), stops it, as does a record that is
# malformed or names another workflow or phase (exit 7).
KEPT_ID="$(node -e 'const [rec,id,w,ph]=process.argv.slice(1);const fs=require("fs"),p=require("path");const good=(v)=>typeof v==="string"&&(v===""||/^[A-Za-z0-9._:-]+$/.test(v)&&!v.includes(".."));const same=(a,b)=>{try{return fs.realpathSync(a)===fs.realpathSync(b)}catch{return p.resolve(a)===p.resolve(b)}};let m,has=true;try{m=JSON.parse(fs.readFileSync(rec,"utf8"))}catch(e){if(!(e&&e.code==="ENOENT"))process.exit(7);has=false}if(has&&(!m||!good(m.run_id)||m.phase!==ph||typeof m.workflow_path!=="string"||!same(m.workflow_path,w)))process.exit(7);if(has&&m.run_id!==id){process.stdout.write(m.run_id);process.exit(3)}if(!has){try{fs.writeFileSync(rec,JSON.stringify({run_id:id,workflow_path:w,phase:ph})+"\n")}catch{process.exit(8)}}process.stdout.write(id);process.exit(0)' "$TEXT_DIR/finalize-run.json" "$RUN_ID" "$ACTIVE" {{verb}})"
case $? in
  0) ;;
  3) echo "✗ finalize-run.json in TEXT_DIR ($TEXT_DIR), left by an earlier run of this block, keeps run '$KEPT_ID', not '$RUN_ID'; nothing was written. Use a fresh TEXT_DIR for each finalize." >&2; exit 1 ;;
  7) echo "✗ finalize-run.json in TEXT_DIR ($TEXT_DIR), left by an earlier run of this block, is malformed or names another workflow or phase than this one of $ACTIVE; nothing was written. Use a fresh TEXT_DIR for each finalize." >&2; exit 1 ;;
  8) echo "✗ Could not keep the run in TEXT_DIR ($TEXT_DIR) as finalize-run.json; nothing was written." >&2; exit 1 ;;
  *) echo "✗ Could not check finalize-run.json in TEXT_DIR ($TEXT_DIR); nothing was written." >&2; exit 1 ;;
esac
{{#capability dispatch_target}}
# ADR-0068 Decision 5 — the verify form: a request the agent wrote in
# TEXT_DIR (verify-request.json) makes the last write record it with the next
# step verify, in place of the verb form. It is checked here with the last
# write's own checks (verify-request-check; the run settle pops first is not
# counted), before settle, the first write, so a request the last write would
# refuse stops the block with nothing written; a conflict takes none, nor
# does an owner gate (OWNER_GATE, which a note holding a gate's heading has
# already required above), and an entry the check cannot read (a dangling
# link) refuses too. The form is kept just before settle (below).
VERIFY_FILE="$TEXT_DIR/verify-request.json"
VERIFY_FORM=''
if [ -e "$VERIFY_FILE" ] || [ -L "$VERIFY_FILE" ]; then
  VERIFY_FORM=verify
  [ "$VERDICT" != conflict ] || { echo "✗ verify-request.json is in TEXT_DIR ($TEXT_DIR), but VERDICT is conflict: a conflict ends on its gate and takes no request. Remove the file; nothing was written." >&2; exit 1; }
  [ -z "$OWNER_GATE" ] || { echo "✗ verify-request.json is in TEXT_DIR ($TEXT_DIR), but OWNER_GATE is $OWNER_GATE: a step that ends on its owner's judgment takes no request, or the driver would run on past it. Remove the file, and the owner-decision form records the gate; nothing was written." >&2; exit 1; }
  node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" verify-request-check \
    --workflow-path "$ACTIVE" --host "${AGENTIC_HOST:-claude}" \
    --request-file "$VERIFY_FILE" --next-step-confidence "$CONFIDENCE" \
    --settling-run-id "$RUN_ID" > /dev/null \
    || { echo "✗ The last write would refuse verify-request.json in TEXT_DIR ($TEXT_DIR), for the reason above; nothing was written. Fix the request, or remove it to end with the verb form, and run this block again." >&2; exit 1; }
fi
{{/capability}}
# The texts the agent wrote with its file tool (ADR-0059, amendment of
# 2026-10-10): each script reads its file itself, so no line of the note is
# shell source. The append reads the note only after settle has written,
# so each file is first held to every reader's rule: strict UTF-8, no NUL
# byte, and text left once blanks are trimmed (settle's rule). A file a
# script would refuse stops the block before any write.
for TEXT_FILE in note.md summary.txt next-action.txt; do
  node -e 'let t;try{t=new TextDecoder("utf-8",{fatal:true}).decode(require("fs").readFileSync(process.argv[1]))}catch{process.exit(1)}process.exit(t.includes("\0")||t.trim()===""?1:0)' "$TEXT_DIR/$TEXT_FILE" || { echo "✗ $TEXT_FILE in TEXT_DIR ($TEXT_DIR) is missing, blank or not UTF-8 text; write it with the file tool first. Nothing was written." >&2; exit 1; }
done
{{#capability dispatch_target}}
# The verify form, kept in TEXT_DIR (finalize-verify.json: the request's
# sha256, or null for the verb form) at the first run, after every check
# above, so a run they stop keeps no form and runs again with a request added:
# run again after a write, the block takes the same form and the same request,
# and a request added, removed or changed since (exit 3) stops it before any
# write.
node -e 'const [rec,f]=process.argv.slice(1);const fs=require("fs");let now=null;try{now=require("crypto").createHash("sha256").update(fs.readFileSync(f)).digest("hex")}catch(e){if(!(e&&e.code==="ENOENT"))process.exit(1)}let m;try{m=JSON.parse(fs.readFileSync(rec,"utf8"))}catch(e){if(!(e&&e.code==="ENOENT"))process.exit(7);try{fs.writeFileSync(rec,JSON.stringify({request_sha256:now})+"\n")}catch{process.exit(8)}process.exit(0)}if(m===null||typeof m!=="object"||!(m.request_sha256===null||typeof m.request_sha256==="string"&&/^[0-9a-f]{64}$/.test(m.request_sha256)))process.exit(7);process.exit(m.request_sha256===now?0:3)' "$TEXT_DIR/finalize-verify.json" "$VERIFY_FILE"
case $? in
  0) ;;
  3) echo "✗ finalize-verify.json in TEXT_DIR ($TEXT_DIR), left by an earlier run of this block, keeps another form than verify-request.json there gives now (the request was added, removed or changed since); nothing was written. Put the request back as it was, or finalize from a fresh TEXT_DIR." >&2; exit 1 ;;
  7) echo "✗ finalize-verify.json in TEXT_DIR ($TEXT_DIR) is malformed; nothing was written. Use a fresh TEXT_DIR for each finalize." >&2; exit 1 ;;
  *) echo "✗ Could not read verify-request.json, or keep the form as finalize-verify.json, in TEXT_DIR ($TEXT_DIR); nothing was written." >&2; exit 1 ;;
esac
{{/capability}}

# ADR-0066 PC2b — settle the ensemble attempt from its ledger (never launched,
# launched and failed, completed). It is the first write and the one judge of
# the run: a refusal (a run still live, of another workflow or phase, or an
# attempt an empty id would hide) stops the block before any write, so the
# workflow never records a note for an attempt left unsettled; once it has
# recorded the run, running the block again records nothing more for it.
node "$CLAUDE_PLUGIN_ROOT/scripts/peer-runner.mjs" settle \
  --repo-root "$REPO_ROOT" --workflow-path "$ACTIVE" \
  --host "${AGENTIC_HOST:-claude}" --phase {{verb}} --run-id "$RUN_ID" \
  --verdict "$VERDICT" --summary-file "$TEXT_DIR/summary.txt" || exit $?

node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" append \
  --workflow-path "$ACTIVE" --host "${AGENTIC_HOST:-claude}" \
  --phase-label {{phase_label}} \
  --phase-note-file "$TEXT_DIR/note.md" \
  --current-phase phase-2-presented \
  --next-action-file "$TEXT_DIR/next-action.txt" \
  --event updated || exit $?

# FAIL-CLOSED: only a CONVERGED of yes, assigned at the top of the block,
# closes the verb.
if [ "${CONVERGED:-no}" = "yes" ]; then
  {{#capability dispatch_target}}
  # The owner-decision form when OWNER_GATE names a gate; otherwise, ADR-0068
  # Decision 5, the verb form unless a request was checked above, and the
  # verify form after the last else.
  if [ -n "$OWNER_GATE" ]; then
    # The gate and the next step owner-decision in one write: the workflow
    # stays open until the owner resolves the gate.
    # A limit (ADR-0068 VR6): interactively, with another owner gate already
    # pending, this write refuses after settle and the note, so a rerun appends
    # the note again; an autopilot run's preflight refuses a pending gate first.
    # ARCHIVE TIMING — with an owner gate this write is never terminal, so the
    # Stop hook, which fires at EVERY turn end on Claude, leaves the workflow
    # active (it refuses to archive while a gate is pending); the
    # `--terminal-marker false` escape is not needed. On Codex the Stop hook runs
    # only once the plugin hooks are trusted (`/hooks`).
    node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" finish-verb \
      --workflow-path "$ACTIVE" --host "${AGENTIC_HOST:-claude}" \
      --operation-dir "$OP_DIR" \
      --next-action-file "$TEXT_DIR/next-action.txt" \
      --next-step-kind owner-decision --next-step-confidence "$CONFIDENCE" \
      --owner-gate "$OWNER_GATE" --owner-gate-anchor "$OWNER_GATE_ANCHOR" || exit $?
  elif [ -z "$VERIFY_FORM" ]; then
  {{/capability}}
  # ADR-0029 §1 / completion-output contract §2 — next-action.txt, which the
  # append above and this terminal write record, holds the COMPACT form of the
  # proposal above (selected_next + one-line why + next_command) so the
  # durable state and the code-emitted completion footer agree with the
  # Active Next-Action Proposal. Step 2 shows the typical-case default; write
  # another, and change the --next-step-* flags, when the verb's result
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
  {{#capability dispatch_target}}
    --operation-dir "$OP_DIR" \
  {{/capability}}
    --next-action-file "$TEXT_DIR/next-action.txt" \
    --next-step-kind verb --next-step-verb {{next_verb}} \
    --next-step-confidence "$CONFIDENCE" || exit $?
  {{#capability dispatch_target}}
  else
    # The verify form: the request and the next step verify in one write; the
    # driver runs the checks, then dispatches the request's on_pass, or resumes
    # this verb with the results.
    # ARCHIVE TIMING — this write is never terminal (an autopilot run only, and
    # it turns the marker off), so the Stop hook, which fires at EVERY turn end
    # on Claude, leaves the workflow active; the `--terminal-marker false`
    # escape is not needed. On Codex no run offers verification.
    node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" finish-verb \
      --workflow-path "$ACTIVE" --host "${AGENTIC_HOST:-claude}" \
      --operation-dir "$OP_DIR" \
      --next-action-file "$TEXT_DIR/next-action.txt" \
      --next-step-kind verify --next-step-confidence "$CONFIDENCE" \
      --verify-request-file "$VERIFY_FILE" || exit $?
  fi
  {{/capability}}
else
  {{#capability dispatch_target}}
  # Not converged, a named owner gate is still the last write. A limit
  # (ADR-0068 VR6), latent while no persona renders this variant with
  # dispatch_target: a checked verify-request.json is not recorded here.
  if [ -n "$OWNER_GATE" ]; then
    # The gate and the next step owner-decision in one write: the workflow
    # stays open until the owner resolves the gate.
    # A limit (ADR-0068 VR6): interactively, with another owner gate already
    # pending, this write refuses after settle and the note, so a rerun appends
    # the note again; an autopilot run's preflight refuses a pending gate first.
    # ARCHIVE TIMING — with an owner gate this write is never terminal, so the
    # Stop hook, which fires at EVERY turn end on Claude, leaves the workflow
    # active (it refuses to archive while a gate is pending); the
    # `--terminal-marker false` escape is not needed. On Codex the Stop hook runs
    # only once the plugin hooks are trusted (`/hooks`).
    node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" finish-verb \
      --workflow-path "$ACTIVE" --host "${AGENTIC_HOST:-claude}" \
      --operation-dir "$OP_DIR" \
      --next-action-file "$TEXT_DIR/next-action.txt" \
      --next-step-kind owner-decision --next-step-confidence "$CONFIDENCE" \
      --owner-gate "$OWNER_GATE" --owner-gate-anchor "$OWNER_GATE_ANCHOR" || exit $?
  else
  {{/capability}}
  # Not converged: the workflow stays open, with the next step that resolves
  # the flagged item, and a terminal marker an earlier verb left turned off.
  node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" append \
    --workflow-path "$ACTIVE" --host "${AGENTIC_HOST:-claude}" \
  {{#capability dispatch_target}}
    --operation-dir "$OP_DIR" --close-operation true \
  {{/capability}}
    --current-phase phase-2-presented \
    --next-action-file "$TEXT_DIR/next-action.txt" \
    --next-step-kind verb --next-step-verb "$RESOLVE_VERB" \
    --next-step-confidence "$CONFIDENCE" \
    --clear-terminal-marker true --event updated || exit $?
  echo "→ PAUSED (not converged): the workflow stays open, not terminal. Resolve the flagged item, then run the next step recorded above." >&2
  {{#capability dispatch_target}}
  fi
  {{/capability}}
fi
{{^capability dispatch_target}}
# The owner-decision form, for an owner gate named above this block: it
# records the gate with the next step in one write, and the workflow stays
# open until the owner resolves the gate.
# node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" finish-verb \
#   --workflow-path "$ACTIVE" --host "${AGENTIC_HOST:-claude}" \
#   --next-action-file "$TEXT_DIR/next-action.txt" \
#   --next-step-kind owner-decision --next-step-confidence "$CONFIDENCE" \
#   --owner-gate '<gate>' --owner-gate-anchor '<anchor>' || exit $?
{{/capability}}
```
