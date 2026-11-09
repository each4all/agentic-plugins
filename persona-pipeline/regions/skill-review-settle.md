**On Codex, the skill settles its review (C163 A1a).** Besides the
workflow writes the state-write note above names, on Codex this skill also
settles its review in the workflow. A review leaves one outcome per attempt in the
workflow (ADR-0023, implementation note of 2026-11-05), and it is the settle
that records it. On Claude,
`/{{persona}}:{{verb}}`'s finalize settles the attempt, and inside
`/{{persona}}:start` or `${{persona}}:start` the lifecycle settles each phase:
skip this step there. On Codex, `${{persona}}:{{verb}}` has no command file to
run that finalize (ADR-0013), so when `state.mjs find-active` names an active
{{persona}} workflow on this branch, this skill settles the attempt itself,
once the synthesis is done and before it reports. Where the skill runs more
than one review in one run (refine's loop), it settles each earlier pass's
attempt, launched or not, as its own step says, and this block settles the
last pass's only. Left unsettled, a launched
review stays an open attempt that reads `unknown`, and one that never launched
leaves no attempt at all. With no active workflow there is nothing to record:
dispatch with no `--workflow-path`, and skip this step.

Dispatch the review as the ensemble protocol's Launch step says, through
`peer-runner.mjs run` with the workflow's accounting flags, all of them:
`--kind ensemble --workflow-path <the active workflow> --phase {{verb}}
--ensemble-type <type> --host codex --run-id <id>`, the id printed by
`peer-runner.mjs new-run-id --prefix <type>`, and the type {{review_types}}.
Without `--kind ensemble` the runner records a manual run: no attempt is
registered, and settle refuses the run. Write the prompt as
`prompt.xml` in its own `mktemp -d` directory, and send the runner's JSON
result to `prompt.xml.run.json` beside it: that directory is the block's
`DISPATCH_DIR`. Beside the prompt, with your file-writing tool, write
`subject.json`, what you put in the reviewer's subject, `{"shown": [...],
"covered": [...]}` (repository-relative paths; `covered` are those shown at the
content the working tree holds now; ADR-0069 Decision 1, item 6), and pass it
with `--subject-file <that file>`. A review with no subject vouches for nothing.

The synthesis's summary reaches settle as a file, never in the block: in
shell source a quote, `$`, backtick or line break of it would be read as code
(ADR-0059, amendment of 2026-10-10). After the synthesis:

1. Create a private directory for it, and note the path it prints:

   ```bash
   mktemp -d "${TMPDIR:-/tmp}/agentic-text.XXXXXX"
   ```

2. With your file-writing tool, not the shell, create `summary.txt` in that
   directory holding a one-line résumé of the synthesis, ending with one
   newline. Nothing deletes it.

Then run the block with `TEXT_DIR` set to that directory and `<plugin-root>`
filled with this plugin's installed root, the path you read this SKILL.md
from, cut before its `/core/skills/` directory:

- a run launched: `DISPATCH_DIR` set, `VERDICT` the synthesis verdict, one
  word, this verb's
  {{verdicts}},
  or `degraded` when the answer parses to nothing usable or the run failed.
  `NO_RUN_REASON` is left empty. Settle
  decides from the run's ledger what is recorded: a run that failed records
  `failed`, `unavailable` or `malformed` whatever the verdict, and an empty
  or unreadable answer `degraded`.
- no run launched: `DISPATCH_DIR` and `VERDICT` empty, `ENSEMBLE_TYPE` the type the
  dispatch would have used (the block names this skill's default; set the
  other only where the skill picked that point type), and `NO_RUN_REASON`
  why: `peer-unavailable` (the companion or the peer's CLI was not found
  before any run), `local-only`, `privacy-gate` (the prompt could not be
  made safe to send) or `owner-skip`. The attempt is recorded `unavailable`
  or `skipped` under an id derived from `TEXT_DIR`, so a rerun of this block
  with the same `TEXT_DIR` records it once; use a new `TEXT_DIR` for each
  attempt. With no run launched, a review still says what its local
  reviewers read: with your file-writing tool create `subject.json` in
  `TEXT_DIR`, beside `summary.txt` (there is no prompt for it to sit beside),
  in the form the dispatch step above gives (`{"shown": [...], "covered":
  [...]}`), and settle records it with the attempt (ADR-0069). With no such
  file the attempt covers no path and never binds.

A type that is not one of this verb's review types, or a reason not in that
list, stops the block before any write: settle would record nothing for a type
that is no review. The check is the verb's, shared by every persona: it does
not know whether this persona's skill ever picks the other type, so keep the
default unless the skill's own step names the other point type.

A launched run's `VERDICT` must be one of the words the persona verbs use:
`agreed`, `resolved`, `concerns`, `regression`, `conflict` or `degraded`.
Any other stops the block before any write: a word settle does not know
(`AGREED`, `looks good`, the unfilled placeholder) would record a clean
review `failed` (`unrecognized-verdict`), and `failed` itself is refused by
settle for a run that completed. So do a `VERDICT` set with no run
launched, a `TEXT_DIR` or `DISPATCH_DIR` left as its placeholder, and an
empty `TEXT_DIR`. The check takes every persona verb's words: settle reads
`agreed` and `resolved` alike, so keep to this verb's.

```bash
TEXT_DIR='<the directory holding summary.txt>'
DISPATCH_DIR='<the directory the dispatch ran with; empty when no run launched>'
VERDICT='<the synthesis verdict; empty when no run launched>'
# The review type the dispatch used, or would have used: this skill's default,
# or the other type where the skill picked that point type.
ENSEMBLE_TYPE={{review_type}}
# Why no run launched (peer-unavailable, local-only, privacy-gate or
# owner-skip); empty when a run launched.
NO_RUN_REASON=''
case "$ENSEMBLE_TYPE" in
  {{review_type}}|{{review_type_other}}) ;;
  *) echo "✗ ENSEMBLE_TYPE is not one of this verb's review types; nothing was settled." >&2; exit 1 ;;
esac
case "$NO_RUN_REASON" in
  ''|peer-unavailable|local-only|privacy-gate|owner-skip) ;;
  *) echo "✗ NO_RUN_REASON is not peer-unavailable, local-only, privacy-gate or owner-skip (empty when a run launched); nothing was settled." >&2; exit 1 ;;
esac
# A placeholder left as written opens with "<"; a directory mktemp printed
# is an absolute path, which never does, whatever it holds further on.
for FILLED in "$TEXT_DIR" "$DISPATCH_DIR"; do
  case "$FILLED" in
    '<'*) echo "✗ TEXT_DIR or DISPATCH_DIR is not filled in (DISPATCH_DIR empty when no run launched); nothing was settled." >&2; exit 1 ;;
  esac
done
[ -n "$TEXT_DIR" ] || { echo "✗ TEXT_DIR is empty: set it to the directory holding summary.txt; nothing was settled." >&2; exit 1; }
# The verdict, one of the words the persona verbs use: most others would
# record a clean review as failed (unrecognized-verdict). None when no run
# launched.
if [ -n "$DISPATCH_DIR" ]; then
  case "$VERDICT" in
    agreed|resolved|concerns|regression|conflict|degraded) ;;
    *) echo "✗ VERDICT is not agreed, resolved, concerns, regression, conflict or degraded, the words settle maps; nothing was settled." >&2; exit 1 ;;
  esac
elif [ -n "$VERDICT" ]; then
  echo "✗ VERDICT is set, but DISPATCH_DIR is empty (no run launched, so there is no verdict): empty one or set the other; nothing was settled." >&2
  exit 1
fi
# A fresh shell: the workflow is found again here. With none on this branch
# there is nothing to record.
REPO_ROOT="$(git rev-parse --show-toplevel)" || exit 1
ACTIVE="$(node "<plugin-root>/scripts/state.mjs" find-active --repo-root "$REPO_ROOT")" || exit $?
[ -n "$ACTIVE" ] || { echo "No active workflow on this branch: no review attempt to settle." >&2; exit 0; }
if [ -n "$DISPATCH_DIR" ]; then
  # The run's id, from the result the runner wrote beside the prompt, never
  # retyped: a well-formed run id (letters, digits, ".", "_", ":", "-", no "..").
  RUN_ID="$(node -e 'const fs=require("fs"),p=require("path");let r;try{r=JSON.parse(fs.readFileSync(p.join(process.argv[1],"prompt.xml.run.json"),"utf8"))}catch{process.exit(1)}const id=r&&r.run_id;if(typeof id!=="string"||!/^[A-Za-z0-9._:-]+$/.test(id)||id.includes(".."))process.exit(1);process.stdout.write(id)' "$DISPATCH_DIR")" \
    || { echo "✗ prompt.xml.run.json in DISPATCH_DIR ($DISPATCH_DIR) names no run id (a runner killed before it wrote its result leaves it empty): settle that run by hand, peer-runner.mjs settle --run-id <the id the dispatch passed as --run-id>. Nothing was settled." >&2; exit 1; }
  node "<plugin-root>/scripts/peer-runner.mjs" settle --repo-root "$REPO_ROOT" \
    --workflow-path "$ACTIVE" --host codex --phase {{phase}} --run-id "$RUN_ID" \
    --verdict "$VERDICT" --summary-file "$TEXT_DIR/summary.txt" || exit $?
else
  node "<plugin-root>/scripts/peer-runner.mjs" settle --repo-root "$REPO_ROOT" \
    --workflow-path "$ACTIVE" --host codex --phase {{phase}} --run-id '' \
    --ensemble-type "$ENSEMBLE_TYPE" --no-run-reason "$NO_RUN_REASON" \
    --subject-file "$TEXT_DIR/subject.json" \
    --attempt-key "$TEXT_DIR" || exit $?
fi
```

Settle refuses, writing nothing, while the run is still live (collect it
first), for a run of another workflow or phase, and with `DISPATCH_DIR` empty
while a run of this phase is pending (settle that run by its id). Once it has
recorded the attempt, running it again records nothing more.
