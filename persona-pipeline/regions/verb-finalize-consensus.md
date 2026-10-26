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
`VERDICT` alone, and before it appends the phase note. Recorded `conflict`,
with `VERDICT` set to `conflict`, it writes the contested items to that task
file (`consensus-task`), then appends the note and records the gate with the
run id in the same write as the next step `owner-decision`.
Whenever `VERDICT` is `conflict`, write the contested items before you run
the block, with the file tool, as `contested.md` in the `TEXT_DIR` directory:
each CONFLICT item with both positions and their evidence, prepared as the
peer prompt was, since the consensus peers read it. They come from the peers'
positions, so never put them in the block: there the shell would read a line
of them as a command. With `VERDICT` set to `conflict`, a `contested.md`
missing, blank or not UTF-8 text stops the block before any write. When the
recorded verdict and `VERDICT` disagree (a run recorded `failed`, or a conflict
recorded by an earlier attempt), or the task file cannot be written, the
block stops after the settle and before the phase note, and its message says
what to set: the recorded verdict, with `contested.md` when that is
`conflict`, or, for a conflict with no run named, the run's directory. Run
the block again: its settle does nothing for a run it already recorded, so
the branch that matches runs and the note is appended once: on a conflict,
`consensus-task` first, then the note and the gate. Nothing runs the consensus round: the
owner does, then rules, and clearing the gate retires the task file. compose,
frame and refine, and every other verdict, never take this branch.

Before settle, the block reads every result this phase recorded on the
workflow, and the gate it holds. A recorded conflict with no owner ruling
holds the phase, and only that same run, finalized with `VERDICT` set to
`conflict`, gets past it. Two machine-written records count as a ruling:
this verb's conflict gate, pending and naming that run, and that run's
retired task file (the owner cleared the gate). While this verb's conflict
gate is pending, it holds every finish but a run of the block for the gate's
own run with `VERDICT` set to `conflict`, the empty id included; its message
says the owner resolves the gate first. With no such gate pending, a
conflict whose task file was never retired (the gate was never set, for
example because an earlier run of the block stopped at `consensus-task`)
holds every finish but its own run's as a conflict, whatever later run the
phase recorded since: any other `VERDICT`, the empty id, and any other run
finalized as a conflict stop the block before any write, and its message
names that run, to finalize first with `VERDICT` set to `conflict`. A
conflict whose id could never name a gate (a run settled by hand under such
an id) stops it too, and its message says the owner decides it: no run of the
block can end it on its gate. A recorded conflict thus never ends without its
gate. With `VERDICT` set to
`conflict`, the run id must also suit the task file and the gate: a letter or
digit, then letters, digits, `_` and `-`, 128 at most, as the runbook's
dispatch makes them; and on every path an id opening with `--` stops the
block, since the verdict read takes it as a flag. Both stop it before any
write.

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
{{/capability}}

```bash
TEXT_DIR='<directory from step 1>'
DISPATCH_DIR='<the directory the dispatch block ran with; empty when no run launched; the run ledger directory when a run launched and that directory is gone>'
VERDICT='<the synthesis verdict>'
CONFIDENCE='<HIGH|MEDIUM|LOW>'
{{#capability dispatch_target}}
OP_DIR='<the operation directory the Phase 0 block printed as OP_DIR; empty when it printed none>'
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
# The texts the agent wrote with its file tool (ADR-0059, amendment of
# 2026-10-10): each script reads its file itself, so no line of the note is
# shell source. The append reads the note only after settle has written,
# so each file is first held to every reader's rule: strict UTF-8, no NUL
# byte, and text left once blanks are trimmed (settle's rule). A file a
# script would refuse stops the block before any write.
for TEXT_FILE in note.md summary.txt next-action.txt; do
  node -e 'let t;try{t=new TextDecoder("utf-8",{fatal:true}).decode(require("fs").readFileSync(process.argv[1]))}catch{process.exit(1)}process.exit(t.includes("\0")||t.trim()===""?1:0)' "$TEXT_DIR/$TEXT_FILE" || { echo "✗ $TEXT_FILE in TEXT_DIR ($TEXT_DIR) is missing, blank or not UTF-8 text; write it with the file tool first. Nothing was written." >&2; exit 1; }
done
# The contested items a conflict ends on, from contested.md, held to the same
# rule here: a conflict without them would stop after the settle, before the
# gate.
if [ "$VERDICT" = conflict ]; then
  node -e 'let t;try{t=new TextDecoder("utf-8",{fatal:true}).decode(require("fs").readFileSync(process.argv[1]))}catch{process.exit(1)}process.exit(t.includes("\0")||t.trim()===""?1:0)' "$TEXT_DIR/contested.md" || { echo "✗ contested.md in TEXT_DIR ($TEXT_DIR) is missing, blank or not UTF-8 text; a conflict needs the contested items: write them with the file tool first. Nothing was written." >&2; exit 1; }
fi
# The run id where the later steps of this variant read it: the verdict read
# runs on every path, and state.mjs's parser takes a value opening with "--"
# as a flag; a conflict's run id names its task file and its gate (state.mjs
# isSafeConsensusRunId: a letter or digit, then letters, digits, "_" and "-",
# 128 at most). An id either would refuse stops the block here, before any
# write.
case "$RUN_ID" in
  --*) echo "✗ Run id '$RUN_ID' opens with '--', which state.mjs reads as a flag; nothing was written. Settle the run by hand (peer-runner.mjs settle --run-id), then run this block with DISPATCH_DIR empty from a fresh TEXT_DIR." >&2; exit 1 ;;
esac
if [ "$VERDICT" = conflict ] && [ -n "$RUN_ID" ]; then
  node -e 'process.exit(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(process.argv[1])?0:1)' "$RUN_ID" || { echo "✗ VERDICT is conflict, but run id '$RUN_ID' cannot name a consensus task file or a gate (a letter or digit, then letters, digits, _ and -, 128 at most, as the runbook's dispatch makes them); nothing was written. Dispatch the review again with the runbook's dispatch block, settle this run by hand (peer-runner.mjs settle --run-id), and finalize the new run." >&2; exit 1; }
fi
# R4 K2, L1, L2 — the conflict itself holds the phase, from the workflow's
# own record: every result this phase recorded, not only the last, and the
# gate. While this verb's conflict gate is pending (a run id left without its
# gate, or another gate, is none), only the gate's own run, finalized as a
# conflict, passes (gate). With none pending, a conflict whose task file was
# never retired passes only its own run finalized as a conflict, so any other
# VERDICT, the empty id, and another run as a conflict stop the block here
# (conflict); a conflict whose id could never name a gate holds it too: no run
# of the block can end that one, so it is the owner's (owner). Read before
# settle: a run settled now is not yet recorded, and a run recorded later
# cannot hide an earlier conflict. A read that fails, or prints no workflow,
# stops it too (the read is checked on its own: a pipe reports its last
# command).
WF_JSON="$(node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" read --workflow-path "$ACTIVE")" \
  || { echo "✗ Could not read the results recorded on $ACTIVE; nothing was written." >&2; exit 1; }
HOLD="$(printf '%s' "$WF_JSON" | node -e 'let s="";process.stdin.setEncoding("utf8");process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{const [w,ph,g,run,v]=process.argv.slice(1);const fs=require("fs"),p=require("path");let o;try{o=JSON.parse(s)}catch{process.exit(1)}if(o===null||typeof o!=="object")process.exit(1);const safe=(id)=>/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(id);const named=(id)=>id===""?"(no id)":id;if(o.awaiting_owner_gate===g){const gr=typeof o.awaiting_owner_run_id==="string"?o.awaiting_owner_run_id:"";if(gr===""||run!==gr||v!=="conflict")process.stdout.write("gate "+named(gr));process.exit(0)}const held=(Array.isArray(o.ensemble_results)?o.ensemble_results:[]).filter((e)=>e&&e.phase===ph&&e.verdict==="conflict").map((e)=>typeof e.run_id==="string"?e.run_id:"").filter((id)=>!(safe(id)&&typeof o.workflow_id==="string"&&fs.existsSync(p.join(p.dirname(p.dirname(w)),"consensus",o.workflow_id+"."+id+".resolved.md"))));if(held.length===0||(v==="conflict"&&run!==""&&held.includes(run)))process.exit(0);const owner=held.find((id)=>!safe(id));process.stdout.write(owner===undefined?"conflict "+held[0]:"owner "+named(owner))})' "$ACTIVE" {{verb}} {{conflict_gate_word}} "$RUN_ID" "$VERDICT")" \
  || { echo "✗ The read of $ACTIVE printed no workflow; nothing was written." >&2; exit 1; }
HELD_RUN="${HOLD#* }"
case "$HOLD" in
  '') ;;
  'gate (no id)')
    echo "✗ This verb's conflict gate is pending and names no run: until the owner rules on it, no run of this block can finish the verb. The owner resolves the gate first; nothing was written." >&2
    exit 1 ;;
  gate\ *)
    echo "✗ This verb's conflict gate is pending for run $HELD_RUN: until the owner rules on it, only that run, finalized again with VERDICT conflict, can run this block, so VERDICT $VERDICT for run '$RUN_ID' cannot. The owner resolves the gate first; nothing was written." >&2
    exit 1 ;;
  owner\ *)
    echo "✗ Run $HELD_RUN is recorded in this phase with the verdict conflict, and no owner ruling names it: a recorded conflict ends on its gate. Its id cannot name a consensus task file or a gate (a letter or digit, then letters, digits, _ and -, 128 at most), so no run of this block can end it on its gate: the conflict is the owner's to decide, outside this block. Nothing was written." >&2
    exit 1 ;;
  *)
    echo "✗ Run $HELD_RUN is recorded in this phase with the verdict conflict, and no owner ruling names it: a recorded conflict ends on its gate, so only that run, finalized with VERDICT conflict, can finish the verb, not VERDICT $VERDICT for run '$RUN_ID'. Finalize that run first: set DISPATCH_DIR to its directory, or to its ledger directory when that is gone, VERDICT to conflict, write contested.md, and run this block from a fresh TEXT_DIR. Nothing was written." >&2
    exit 1 ;;
esac

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

# ADR-0067 Decision 8 — the verdict the settle above recorded for the run
# (empty when it recorded none), read before the phase note: a mismatch, or a
# conflict whose task file cannot be written, stops the block with the settle
# its only write, so running it again (the settle records nothing more)
# appends the note once (R4 J2, J4). A recorded conflict does not close the
# verb: it writes the contested items as the consensus task file and ends on
# the conflict gate, bound to its run. Any other verdict makes the typical
# last write.
RECORDED="$(node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" ensemble-verdict \
  --workflow-path "$ACTIVE" --run-id "$RUN_ID")" || exit $?
if [ "$RECORDED" = conflict ] && [ "$VERDICT" = conflict ]; then
  # The contested items, from contested.md, written with the file tool: the
  # shell never reads them, so no line of them runs as a command. A file
  # missing stops the block before the note; consensus-task refuses an empty
  # one.
  CONTESTED_FILE="$TEXT_DIR/contested.md"
  [ -f "$CONTESTED_FILE" ] || { echo "✗ contested.md in TEXT_DIR ($TEXT_DIR) is missing; the phase note and the gate were not recorded. Write it with the file tool and run this block again." >&2; exit 1; }
  # The task file, once the settle above recorded the run with the verdict
  # conflict; it prints the consensus round the proposal selects. Written
  # again on a later run of the block, it is replaced whole.
  PROPOSED="$(node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" consensus-task \
    --workflow-path "$ACTIVE" --host "${AGENTIC_HOST:-claude}" --run-id "$RUN_ID" \
    --text-file "$CONTESTED_FILE")" \
    || { echo "✗ The consensus task file for run $RUN_ID was not written; the phase note and the gate were not recorded. Run this block again with the same TEXT_DIR and DISPATCH_DIR: its settle records nothing more for the run." >&2; exit 1; }
elif [ "$RECORDED" = conflict ]; then
  echo "✗ Run $RUN_ID is recorded with the verdict conflict (an earlier run of this block settled it), but VERDICT is $VERDICT: a recorded conflict ends on its gate. Set VERDICT to conflict, write contested.md, and run this block again with the same DISPATCH_DIR. The settle aside, nothing was written." >&2
  exit 1
elif [ "$VERDICT" = conflict ] && [ -z "$RUN_ID" ]; then
  echo "✗ VERDICT is conflict, but DISPATCH_DIR names no run, so no conflict is recorded for a consensus round. Set DISPATCH_DIR to the directory the dispatch block ran with, or to the run's ledger directory when that is gone, and run this block again from a fresh TEXT_DIR. Nothing was written." >&2
  exit 1
elif [ "$VERDICT" = conflict ]; then
  echo "✗ VERDICT is conflict, but run $RUN_ID is recorded with ${RECORDED:-no verdict}: a consensus round needs a recorded conflict. Set VERDICT to ${RECORDED:-the recorded verdict}, rewrite the synthesis heading of note.md to that verdict, and run this block again with the same TEXT_DIR and DISPATCH_DIR: its settle records nothing more for the run. The settle aside, nothing was written." >&2
  exit 1
fi

node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" append \
  --workflow-path "$ACTIVE" --host "${AGENTIC_HOST:-claude}" \
  --phase-label {{phase_label}} \
  --phase-note-file "$TEXT_DIR/note.md" \
  --current-phase phase-2-presented \
  --next-action-file "$TEXT_DIR/next-action.txt" \
  --event updated || exit $?

if [ "$RECORDED" != conflict ]; then
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
else
  # The gate, bound to its run, and the next step owner-decision in one
  # write: the workflow stays open until the owner rules.
  # ARCHIVE TIMING — with an owner gate this write is never terminal, so the
  # Stop hook, which fires at EVERY turn end on Claude, leaves the workflow
  # active (it refuses to archive while a gate is pending); the
  # `--terminal-marker false` escape is not needed. On Codex the Stop hook runs
  # only once the plugin hooks are trusted (`/hooks`).
  node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" finish-verb \
    --workflow-path "$ACTIVE" --host "${AGENTIC_HOST:-claude}" \
  {{#capability dispatch_target}}
    --operation-dir "$OP_DIR" \
  {{/capability}}
    --next-action "Owner decision, after a bounded consensus round: $PROPOSED" \
    --next-step-kind owner-decision --next-step-confidence "$CONFIDENCE" \
    --owner-gate {{conflict_gate_word}} --owner-gate-anchor ensemble-synthesis \
    --owner-gate-run-id "$RUN_ID" || exit $?
  echo "→ Proposed, for the owner to run before deciding: $PROPOSED" >&2
fi
# The owner-decision form, for an owner gate named above this block: it
# records the gate with the next step in one write, and the workflow stays
# open until the owner resolves the gate.
# node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" finish-verb \
#   --workflow-path "$ACTIVE" --host "${AGENTIC_HOST:-claude}" \
{{#capability dispatch_target}}
#   --operation-dir "$OP_DIR" \
{{/capability}}
#   --next-action-file "$TEXT_DIR/next-action.txt" \
#   --next-step-kind owner-decision --next-step-confidence "$CONFIDENCE" \
#   --owner-gate '<gate>' --owner-gate-anchor '<anchor>' || exit $?
```
