---
name: compose
description: "Produces the artifact: code, plan, brief, interface, prompt, spec — the engineer persona's composition verb (per ADR-0010 §2 — replaces and extends omcc-dev/plan). Use after framing and deciding to actually build the thing. Trigger phrases include 'plan this', 'how should I approach this', 'break this down', 'what are the steps', 'where do I start', 'implementation plan', 'task breakdown', 'implement this', 'write the code', 'build this', 'compose a spec', '계획', '어떻게 만들지', '구현해줘', '작업 분해'."
---

# Compose (engineer persona)

The engineer plugin's composition verb (per ADR-0010 §2). Compose
produces an artifact — typically code or a structured plan — from
a confirmed problem frame and a chosen direction. ADR-0010 explicitly
unifies plan + actual implementation under a single verb because both
are *production* activities; the difference is the artifact type, not
the verb.

| Profile | What it does | omcc-dev equivalent |
|---------|--------------|---------------------|
| `plan` (default) | Produce a structured implementation plan with TDD task list, dependencies, success criteria | omcc-dev `plan` |
| `code` | Produce the actual implementation (write files, run tests) | (no direct equivalent — omcc-dev `/start` Phase 4 covers it inside the command) |

The profile is set via `--profile=<name>` on `/engineer:compose`, or
inferred from the user's intent when auto-activated. A missing
profile defaults to `plan`. An unknown profile value falls back to
`plan` with a one-line user-facing warning.

**Core principle**: a plan precedes code. Code without a plan that
the user has confirmed is speculation; code with a plan can be
verified task-by-task. When the user wants both, run plan first,
get approval, then run code.

**Autopilot mode (Claude only, ADR-0063 D4):** the approval is the
driver's. A `plan` step ends by recording the next step `compose` at the
plan's confidence, and the driver runs the `code` step only on HIGH; the
macro plan the owner approved is the scope. Never commit: record
`commit` as the next step when the code is ready.

---

## When auto-activated (without command)

Lightweight in-context composition — no subagent spawning, no peer
ensemble dispatch.

### Step 1: Profile selection

1. Inspect the user's request. If they ask "how should I approach
   X" / "break this down" → `plan` profile. If they ask "implement
   X" / "build this now" → `code` profile.
2. If the request is ambiguous, default to `plan` and ask whether
   to proceed to `code` after the plan is approved.

### Step 2: Verify upstream work

Compose consumes upstream output:

- A confirmed problem frame from `/engineer:frame` (or equivalent
  problem statement).
- A confirmed direction from `/engineer:decide` (when 2+ viable
  approaches existed).

If either is missing, suggest running the upstream verb first
rather than composing on incomplete inputs. Composing without a
frame produces a generic artifact; composing without a decision
when alternatives exist locks in an undeliberated choice.

### Step 3a: Produce a plan (`plan` profile)

For each unit of work, capture:

```
### Task [N]: [name]
- **Goal**: [what this task accomplishes — observable outcome]
- **Approach**: [1-2 sentence sketch]
- **Files affected**: [paths]
- **Test**: [the failing test that demonstrates the goal is met]
- **Dependencies**: [task numbers that must complete first]
- **Estimated complexity**: [low / medium / high]
```

Then list tasks in dependency order. Identify the critical path.
Flag tasks with high complexity for early scrutiny.

### Step 3b: Produce code (`code` profile)

Execute the plan task by task following RED-GREEN-REFACTOR:

1. **RED**: write a failing test first; confirm failure with Bash.
2. **GREEN**: minimal implementation to pass the test.
3. **REFACTOR**: clean up while keeping tests green.

In projects without a test framework, skip the cycle, implement
directly, and verify each task manually — inform the user about
the absent framework.

If a task reveals the plan needs adjustment:

1. **Remaining tasks only affected** → adjust remaining task
   descriptions inline; report to user.
2. **Completed code also affected** → report with impact
   assessment; re-run plan for the affected scope.
3. **Decision itself invalidated** → return to
   `/engineer:decide` with the new evidence; do not patch a code
   path built on the broken decision.

<!-- pipeline:begin compose-long-checks -->
### Long checks (ADR-0068 Decision 5)

Sort the checks a change needs by the work they are expected to take:

- **Quick:** a few test files the change touches, expected to finish within
  minutes. Run them in the step, as always, and get them green first.
- **Long:** the whole test suite, a broad `npm test` (a directory, a glob,
  many files), any test file known to run long, and every mutation run
  (`npm run mutate`, and `npm run mutate:static` over every spec).

Where a long check runs depends on the session:

- **Under an autopilot run that offers verification** (Phase 0's preflight
  banner ends `This run offers verification`): run no long check in the
  step, and never wait for the heavy-work lock there — a wait on a lock is
  quiet and idle, which the driver judges stalled. Hand the long checks to the driver instead, with the finalize's
  verify form (`verify-request.json`): it runs them with no LLM after the step
  ends, and the step that follows reads their results, which Phase 0 prints.
  Failing tests named there are the evidence to work from; a check that ended
  with no evidence (a timeout, one cut short or never reached) says nothing
  about the code. What a request names depends on the step that follows it
  (ADR-0068 Decision 5, amendment of 2026-11-10):
  - **An intermediate request** (its `on_pass` is a verb, as after composing
    or refining): name only the test files the change touches. Do not name
    the whole suite, a broad `npm test` or a broad mutation set: the driver
    adds the small and medium tests the change selects, and the large ones
    wait for the final run. Name mutation cases only when the change touches
    gate or fail-closed code (a check that refuses, a guard, a bound), and
    then only those cases. A step with no test file to name names the
    cheapest declared check its change triggers.
  - **The final request** (its `on_pass` is `commit` or `done`): name the
    whole suite, the `test-suite` check, when the repository declares it. Its
    pass is the evidence the commit needs, and it holds only for the tree it
    ran on: after any later edit, regeneration, commit or rebase the driver
    asks for it again, and resumes a verb that asks for the commit without it.
  - **One batch runs at most 6 case ids of mutation in all**, the request's
    and the driver's together: a request over that is refused before any
    write.

  Recording the same checks again on an unchanged tree after they passed
  runs nothing: the driver reuses the pass once. A second time, or after one
  failed, it halts the lane `no-progress`: change the code first (the owner
  reruns a flaky check with `--next verify`).
- **Under an autopilot run that does not offer it** (the banner ends `This
  run does not offer verification`): in the step, as before.
- **Interactively:** run a long check under the repository's heavy-work lock,
  so it does not run beside another session's heavy work:
  `agentic-autopilot heavy -- <command>` (or `node <orchestrator plugin
  root>/adapters/claude/autopilot/cli.mjs heavy -- <command>`). A command that
  takes the lock itself, as the mutation harness does (`locks_itself` in
  `.agentic-plugins/verify-checks.json`), runs directly: the wrapper refuses
  it. With no orchestrator installed, run the check directly.
<!-- pipeline:end compose-long-checks -->

### Step 4: Present and confirm

Follow the Presentation Mode Protocol
(`../_shared/references/presentation-protocol.md`) before presenting.

For `plan`: present the full task list as a single decision item
(the plan), with a recommendation on first task to start.

For `code`: present the diff per task as you go; ask for confirmation
before moving to the next task when the diff is non-trivial. Under
autopilot (Claude only) there is no per-task confirmation: implement the
plan's tasks in order, and a task that invalidates the decision stops the
step with the next step `owner-decision`.

---

## When invoked by command (`/engineer:compose` Claude command or `$engineer:compose` Codex skill mention)

Full composition with Task Profile + peer ensemble + state-write.

### Step 1: Task Profile

Build the Task Profile per
`../_shared/references/orchestration.md` Step 1.

### Step 2: Compose

Follow Step 3a (plan) or Step 3b (code) above.

### Step 3: Peer ensemble parallel analysis

Launch the peer ensemble per
`../_shared/references/ensemble-protocol.md` using the **Plan-verify**
ensemble point type. The peer receives the orchestrator's draft plan
or working-tree diff (the only Independence Rule exception per
ensemble-protocol §Independence Rule) and returns gaps, ordering
issues, risk areas, edge cases.

For `code` profile, the peer ensemble uses the **Review** point
type (peer `task` invocation with the Review prompt template per
`../_shared/references/ensemble-protocol.md` §Review) instead of
Plan-verify when the plan was already verified upstream.

### Step 4: Synthesize

Incorporate valid gaps. Adjust ordering for valid sequencing
issues. Note CONFLICT items for user resolution.

### Step 5: Present

<!-- pipeline:begin compose-present -->
Follow the Presentation Mode Protocol
(`../_shared/references/presentation-protocol.md`) before presenting.

Present the synthesized artifact and confirm before downstream verbs.
<!-- pipeline:end compose-present -->

### State write (when invoked from a workflow command)

<!-- pipeline:begin compose-state-write -->
When `/engineer:compose` runs as a sub-step of another engineer workflow
command, the invoking command writes the artifact + progress to its workflow
file.
This skill itself writes no phase note or progress; its one workflow write is
the `code` profile's commit-manifest recording below, which keeps every file
it writes in the workflow's `commit_manifest` for the commit. When invoked
standalone, no workflow file write occurs.
<!-- pipeline:end compose-state-write -->

### Layer 2 commit-manifest recording (`code` profile only, command-mode only — ADR-0028 §Layer-2)

When this skill runs in `code` profile **and** is invoked as a sub-step
of a workflow command (an active workflow on this branch), record every
Write/Edit on a tracked path into the workflow's
`commit_manifest` so Phase 7 can intersect the manifest with
`git_changes` and stage only the workflow-intended files.
Fill `<plugin-root>` with this plugin's installed root, on either host:
the path you read this SKILL.md from, cut before its
`/core/skills/compose/` directory (`../checkpoint/SKILL.md` has the Plugin
root row for each host). The block reads no variable and no Claude plugin
cache for it: on Codex either would run another copy's `state.mjs`.

```bash
# After each Write or Edit operation on a tracked path during the
# RED-GREEN-REFACTOR loop, append a manifest entry. A fresh shell: the
# workflow is found again here, never carried from an earlier block.
REPO_ROOT="$(git rev-parse --show-toplevel)" || exit 1
ACTIVE="$(node "<plugin-root>/scripts/state.mjs" find-active --repo-root "$REPO_ROOT")" || exit $?
[ -n "$ACTIVE" ] || { echo "✗ No active engineer workflow on this branch; nothing was recorded." >&2; exit 1; }
node "<plugin-root>/scripts/state.mjs" record-composed-file \
  --workflow-path "$ACTIVE" \
  --path "<repo-relative path>" \
  --op create || exit $?   # or "edit" for an existing file
```

Standalone, with no workflow command, skip this step. The snippet finds the
workflow in its own shell, so a manifest entry is never lost to a variable an
earlier Bash call set; with no active workflow it stops instead of recording
nothing (the CLI itself is a no-op when `--workflow-path ""` is passed, the
standalone-mode boundary). `--op` is `create` for a newly added file
and `edit` for a modification of an existing tracked file. The helper
re-uses `validate-commit.mjs#assertSafePath` to reject pathspec
injection at the write boundary (ADR-0028 N1).

`plan` profile composes the plan artifact itself (a state-write through
`state.mjs append`, not a commit-manifest entry). Only `code` profile's
file edits produce commit_manifest rows.

<!-- pipeline:begin compose-review-settle -->
**On Codex, the skill settles its review (C163 A1a).** Besides the
workflow writes the state-write note above names, on Codex this skill also
settles its review in the workflow. A review leaves one outcome per attempt in the
workflow (ADR-0023, implementation note of 2026-11-05), and it is the settle
that records it. On Claude,
`/engineer:compose`'s finalize settles the attempt, and inside
`/engineer:start` or `$engineer:start` the lifecycle settles each phase:
skip this step there. On Codex, `$engineer:compose` has no command file to
run that finalize (ADR-0013), so when `state.mjs find-active` names an active
engineer workflow on this branch, this skill settles the attempt itself,
once the synthesis is done and before it reports. Where the skill runs more
than one review in one run (refine's loop), it settles each earlier pass's
attempt, launched or not, as its own step says, and this block settles the
last pass's only. Left unsettled, a launched
review stays an open attempt that reads `unknown`, and one that never launched
leaves no attempt at all. With no active workflow there is nothing to record:
dispatch with no `--workflow-path`, and skip this step.

Dispatch the review as the ensemble protocol's Launch step says, through
`peer-runner.mjs run` with the workflow's accounting flags, all of them:
`--kind ensemble --workflow-path <the active workflow> --phase compose
--ensemble-type <type> --host codex --run-id <id>`, the id printed by
`peer-runner.mjs new-run-id --prefix <type>`, and the type `plan-verify`, or `review` where this skill picks the Review point type.
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
  `agreed`, `concerns` or `conflict`,
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
ENSEMBLE_TYPE='plan-verify'
# Why no run launched (peer-unavailable, local-only, privacy-gate or
# owner-skip); empty when a run launched.
NO_RUN_REASON=''
case "$ENSEMBLE_TYPE" in
  'plan-verify'|'review') ;;
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
    --workflow-path "$ACTIVE" --host codex --phase 'compose' --run-id "$RUN_ID" \
    --verdict "$VERDICT" --summary-file "$TEXT_DIR/summary.txt" || exit $?
else
  node "<plugin-root>/scripts/peer-runner.mjs" settle --repo-root "$REPO_ROOT" \
    --workflow-path "$ACTIVE" --host codex --phase 'compose' --run-id '' \
    --ensemble-type "$ENSEMBLE_TYPE" --no-run-reason "$NO_RUN_REASON" \
    --subject-file "$TEXT_DIR/subject.json" \
    --attempt-key "$TEXT_DIR" || exit $?
fi
```

Settle refuses, writing nothing, while the run is still live (collect it
first), for a run of another workflow or phase, and with `DISPATCH_DIR` empty
while a run of this phase is pending (settle that run by its id). Once it has
recorded the attempt, running it again records nothing more.
<!-- pipeline:end compose-review-settle -->

---

## Completion — Active Next-Action Proposal

At the end of a successful compose (both the auto-activated and the
command path above), emit an **Active Next-Action Proposal** instead of a
fixed next verb, per `../_shared/references/entry-routing-contract.md`
§ Active Next-Action Proposal — derived from this artifact, not a fixed
table:

```
- selected_next:         <verb | commit | done | owner decision>
- rejected_alternatives: <1-2 alternatives, each + one-line why-not>
- rationale:             <why best — 본질/근본 (essence/foundation) + Standards/Root-Cause gate>
- evidence_pointers:     <phase notes / files / artifacts — pointers only>
- confidence:            <HIGH | MEDIUM | LOW>
- next_command:          <exact next step: /engineer:<verb> … or $engineer:<verb> for a verb; /engineer:commit or $engineer:commit for commit or done; the owner-decision action otherwise>
```

Typical `selected_next` candidates for compose: `/engineer:critique` to
review the artifact — or, for a completed `plan` profile,
`/engineer:compose --profile=code` to implement it. The routing table is
the fallback only when evidence is genuinely neutral — do not end with a
hardcoded "next: X". When `selected_next` is `engineer:decide`, also name
the decision size (`--size=minor|standard|major`) per the contract. The
auto-activated path stays lightweight (ADR-0029 §3): it emits this
proposal shape and routing reasoning without dispatching a peer.

<!-- pipeline:begin compose-finish -->
Run by `/engineer:compose`, the command's last write, `state.mjs
finish-verb`, records this proposal's closed-enum form — `next_step_kind`,
`next_step_verb` and `next_step_confidence` (ADR-0063 D6;
`../_shared/references/entry-routing-contract.md` § Active Next-Action
Proposal); the fields are host-shared. Unless it ends with an owner gate, that
write is terminal. Inside `/engineer:start` no phase makes a verb's
terminal write: the lifecycle makes its one terminal write at its end. A
standalone skill invocation writes no workflow state and emits no footer.
The owner gates, and the step that resolves each:
`../_shared/references/entry-routing-contract.md` § Owner gates.

Autopilot mode, which changes the ceremonies and leaves the terminal marker
unset, is Claude-only (ADR-0063); ignore it on Codex. Under an autopilot run
`finish-verb` writes the next step only and leaves the terminal marker for the
commit command, which alone closes a workflow there, so no footer is printed:
the driver is the handoff.

The runtime completion footer is **code-emitted** on that terminal write
(ADR-0039): its completion state is
`blocked`, with the commit as its unblocking action, when only the commit
remains — `/engineer:commit` commits the change, or closes the workflow
when there is none.
The write fires the session-handoff sidecar, which renders the runtime
`footer.mjs`, the ADR-0031 continue-vs-fresh session handoff included, on that
command's stderr. Do not hand-compose a second footer or hand-pass the
projection; surface the emitted one. On a detached HEAD the branch-based
preflight reports "no active branch context" and never recommends a fresh
session (ADR-0018 §sub-2); the path-targeted terminal sidecar renders the
footer as on a branch, its continue-vs-fresh advice included.
`$engineer:compose` on Codex surfaces the footer as
`/engineer:compose` does. Wiring:
`core/skills/_shared/references/session-handoff.md`.

On Claude the Stop hook fires at **every turn end**, so that terminal write puts
the workflow in front of the archive gates at the end of **that same turn**, not
at session close — it archives then if every gate passes, and otherwise stays
marked for a later Stop to re-evaluate. Clearing the marker
(`--terminal-marker false`, with set-terminal's full flag set) works only before
that Stop fires and does not restore the previous phase. On Codex the hook runs
only once the operator has trusted the plugin hooks (`/hooks`), so evaluation
waits. Full contract: `core/skills/_shared/references/session-handoff.md`
§ Archive timing.
<!-- pipeline:end compose-finish -->

---

## Multi-axis lens at a 2+-branch point (ADR-0029 §2)

When this verb reaches a **genuine 2+-branch decision point** — two
viable implementation designs, or two artifact structures, or a
non-neutral `selected_next` with 2+ candidates in the proposal above —
surface a **compact multi-axis lens** comparing the branches across the
decisive axes (본질/근본 essence/foundation) + the size-appropriate
supporting axes, instead of a flat list, per
`../_shared/references/entry-routing-contract.md`
§ "Surfacing the multi-axis lens from a non-decide verb".

Resolve the sized axis set from the shared `decide-registry.mjs`
resolver (`scripts/decide-registry.mjs resolve --size=<minor|standard|major>`)
— the single axis source of truth, not a hand-authored list. The lens
is bounded: only at a genuine 2+-branch point (not every invocation),
default `--size=minor` (compact 4-axis), never the full 9-axis matrix
for a trivial reversible step.

On Codex the resolver takes one extra step: a skill mention runs with no
plugin-root variable in its environment — the names Codex substitutes into
hook commands are not exported to a skill mention's shell, where
`CLAUDE_PLUGIN_ROOT` and `PLUGIN_ROOT` both read empty — so resolve the
path from the installed plugin root rather than from
`$CLAUDE_PLUGIN_ROOT`. Codex injects the mentioned skill with its absolute
path, and `../checkpoint/SKILL.md` § Claude/Codex command resolution shows
how to take the root from it. When the resolver CLI still does not run,
keep the decisive axes 본질/근본 (essence/foundation, universal to
every preset) and read the size-appropriate supporting axes for the
`compact` preset directly from `../decide/references/decision-axes.yml`
(the registry file is readable even when the resolver CLI is not). Do not
hand-author a supporting-axis list here — the YAML stays the single
source. ADR-0013 owns the missing Codex command file that would run this
resolution automatically, not the reachability of the script.

---

## Anti-patterns (do not produce)

- **Composing without a confirmed frame**. Code without a frame
  hides the assumption that the problem statement is obvious.
- **Skipping the peer ensemble** in command mode. Engineer's policy
  is always-max.
- **Composing through an undecided fork** ("I'll figure it out as
  I go"). Forks belong to `/engineer:decide`; composing through
  them locks in a choice the user did not approve.
- **TDD cycle skipped silently**. If no test framework exists, say
  so explicitly to the user; do not pretend tests are passing.
- **Premature abstraction**. Three similar lines is better than a
  speculative helper. Code only what the current task needs.
