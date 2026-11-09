---
name: critique
description: "Evaluates an existing artifact against evidence, standards, goals, and failure modes — the engineer persona's critique verb (per ADR-0010 §2 — replaces and extends omcc-dev/parallel-review and omcc-dev/audit). Use for code review, design review, audit. Trigger phrases include 'review this', 'check my code', 'code review', 'quality check', 'how does this look', 'any issues with this', 'review my changes', 'check for problems', 'audit', 'audit the codebase', 'full review', '리뷰', '검토해줘', '어떻게 보여', '이상한 부분', '감사', '전체 검토'."
---

# Critique (engineer persona)

The engineer plugin's critique verb (per ADR-0010 §2). Evaluate an
existing artifact (code change, design, plan, config) from multiple
independent perspectives to catch what single-perspective review
misses.

| Profile | What it does | omcc-dev equivalent |
|---------|--------------|---------------------|
| (default) | Standard parallel review of a recent change set (working tree or commit) | omcc-dev `parallel-review` |
| `full-codebase` | Adversarial audit of an entire area or codebase, with sub-focus | omcc-dev `audit` |

A verb-level sugar alias `/engineer:audit` may be published per
ADR-0010 §3 verb-level alias policy, expanding to
`/engineer:critique --profile=full-codebase`. The canonical command
is `/engineer:critique`.

The profile is set via `--profile=<name>` on `/engineer:critique`,
or inferred from the user's intent when auto-activated. A missing
profile means the default (recent diff). An unknown profile value
falls back to default with a one-line user-facing warning.

For `full-codebase` profile, an additional sub-profile (`security`,
`performance`, `code-quality`, `debt`, `full`) narrows the
adversarial focus per `../_shared/references/ensemble-protocol.md`
§Adversarial-scan focus text taxonomy.

**Core principle**: validity is the orchestrator's judgment. When
synthesizing findings (in both modes below), judge each finding's
validity yourself — do not ask the user "is this an issue?". Drop
invalid ones; surface valid ones by severity. The user reviews the
consolidated, already-judged output. When the fix approach involves
2+ viable alternatives, route through `/engineer:decide`.

---

## When auto-activated (without command)

Lightweight in-context review — no subagent spawning, no peer
ensemble dispatch. The orchestrator evaluates each selected
perspective directly in context, so the orchestrator's own git
tools cover the diff.

### Step 1: Identify what to review

For default profile, collect the full change set:

- `git diff --stat` for scope overview
- `git diff --cached` + `git diff` for staged and unstaged hunks
  (together these handle partially staged files that
  `git diff HEAD` can mask)
- `git ls-files --others --exclude-standard` + `Read` each untracked
  file

If there are no uncommitted changes, ask the user what to review.

For `full-codebase` profile, identify the area in scope (a
directory, a feature, the entire repo) and select the sub-profile
focus.

### Step 2: Determine review perspectives

Select perspectives from
`../_shared/references/agent-taxonomy.md` based on the scope of
changes and risk areas. Default candidates: `correctness` and
`conventions`. Add specialist perspectives only when the task's
risk areas apply.

Evaluate each perspective directly in context (auto-activated mode
is meant to be lightweight; subagent dispatch runs under command
mode).

### Step 3: Synthesize

1. Merge findings from all perspectives.
2. Remove duplicates.
3. Sort by severity (CRITICAL > MAJOR > MINOR > SUGGESTION).
4. Follow the Presentation Mode Protocol
   (`../_shared/references/presentation-protocol.md`) before
   presenting.
5. Present consolidated review.

### Output format

```
## Review Summary
[1-2 sentence overall assessment]

## Critical Issues
- [file:line] [perspective] — [description]

## Major Issues
- [file:line] [perspective] — [description]

## Suggestions
- [file:line] [perspective] — [description]

## Looks Good
- [what was done well]
```

Do NOT fix issues in this skill — critique produces findings. The
concrete next step is the Active Next-Action Proposal emitted at
completion (see § Completion below), not a fixed handoff.

---

## When invoked by command (`/engineer:critique` Claude command or `$engineer:critique` Codex skill mention)

Full review with subagent dispatch and peer ensemble parallel
analysis.

### Step 1: Collect change context

Reviewer subagents have read-only file tools and do not run `git`
themselves. The orchestrator collects the change set first and
embeds it in each reviewer's mission:

For a single commit-pending review:

- `git diff --cached` — staged hunks
- `git diff` — unstaged hunks (collected separately to capture
  partially-staged files that `git diff HEAD` can mask)
- `git ls-files --others --exclude-standard` — untracked new files
- Read each untracked file with the `Read` tool so its contents are
  part of the review context.

For an entire-branch review:

- `git diff [base]...HEAD` — the full branch diff. Note untracked
  files separately; they should typically be committed before merge.

For `full-codebase` profile, the orchestrator collects the
relevant files in scope.

<!-- pipeline:begin critique-long-checks -->
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
  about the code. Recording the same checks again on an unchanged tree, after
  they passed or one failed, halts the lane `no-progress`: change the code
  first (the owner reruns a flaky check with `--next verify`).
- **Under an autopilot run that does not offer it** (the banner ends `This
  run does not offer verification`): in the step, as before.
- **Interactively:** run a long check under the repository's heavy-work lock,
  so it does not run beside another session's heavy work:
  `agentic-autopilot heavy -- <command>` (or `node <orchestrator plugin
  root>/adapters/claude/autopilot/cli.mjs heavy -- <command>`). A command that
  takes the lock itself, as the mutation harness does (`locks_itself` in
  `.agentic-plugins/verify-checks.json`), runs directly: the wrapper refuses
  it. With no orchestrator installed, run the check directly.
<!-- pipeline:end critique-long-checks -->

### Step 2: Spawn local agents

Follow `../_shared/references/orchestration.md`, targeting Review
Agents based on the implementation's scope and risk areas. Include
diff hunks and file paths in each reviewer's mission prompt so the
agent can evaluate before/after behavior rather than only current
contents. Launch all selected reviewers in parallel.

### Step 3: Peer ensemble parallel analysis

Simultaneously with subagent dispatch, launch the peer ensemble per
`../_shared/references/ensemble-protocol.md`:

- Default profile → **Review** ensemble point type (peer `task`
  invocation with the Review prompt template per
  `../_shared/references/ensemble-protocol.md` §Review)
- `full-codebase` profile → **Adversarial-scan** ensemble point
  type (peer `task` invocation with the Adversarial-scan prompt
  template + sub-profile focus text per
  `../_shared/references/ensemble-protocol.md` §Adversarial-scan)

The peer call is automatic (always-max policy); skills do not pass
`--model` or `--effort` flags.

### Step 4: Synthesize

After agents return:

1. Collect the peer ensemble result.
2. Deduplicate findings across all sources.
3. Unify severity ratings.
4. Label sources per
   `../_shared/references/ensemble-protocol.md` §Base Synthesis
   Categories.
5. A CONFLICT the synthesis leaves (verdict `conflict`) is the owner's:
   `/engineer:critique` ends with the `peer-conflict` owner gate, with a
   bounded consensus round proposed first (ADR-0067 Decision 8;
   `../_shared/references/entry-routing-contract.md` § Owner gates).

### Step 5: Present

Follow the Presentation Mode Protocol
(`../_shared/references/presentation-protocol.md`) before
presenting. Use the same output shape as auto-activated mode.

Do NOT fix issues in this skill — critique produces findings; the next
action is the Active Next-Action Proposal at completion (see
§ Completion below).

### State write (when invoked from a workflow command)

When `/engineer:critique` is invoked as a sub-step of an engineer workflow
command, the invoking command writes the findings to its workflow
file. This skill itself does not write workflow state — it hands
findings to the invoking command, which owns the write.

When invoked standalone, no workflow file write occurs.

<!-- pipeline:begin critique-review-settle -->
**On Codex, the skill settles its review (C163 A1a).** Besides the
workflow writes the state-write note above names, on Codex this skill also
settles its review in the workflow. A review leaves one outcome per attempt in the
workflow (ADR-0023, implementation note of 2026-11-05), and it is the settle
that records it. On Claude,
`/engineer:critique`'s finalize settles the attempt, and inside
`/engineer:start` or `$engineer:start` the lifecycle settles each phase:
skip this step there. On Codex, `$engineer:critique` has no command file to
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
`--kind ensemble --workflow-path <the active workflow> --phase critique
--ensemble-type <type> --host codex --run-id <id>`, the id printed by
`peer-runner.mjs new-run-id --prefix <type>`, and the type `review`, or `adversarial-scan` where this skill's profile picks the Adversarial-scan point type.
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
ENSEMBLE_TYPE='review'
# Why no run launched (peer-unavailable, local-only, privacy-gate or
# owner-skip); empty when a run launched.
NO_RUN_REASON=''
case "$ENSEMBLE_TYPE" in
  'review'|'adversarial-scan') ;;
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
    --workflow-path "$ACTIVE" --host codex --phase 'critique' --run-id "$RUN_ID" \
    --verdict "$VERDICT" --summary-file "$TEXT_DIR/summary.txt" || exit $?
else
  node "<plugin-root>/scripts/peer-runner.mjs" settle --repo-root "$REPO_ROOT" \
    --workflow-path "$ACTIVE" --host codex --phase 'critique' --run-id '' \
    --ensemble-type "$ENSEMBLE_TYPE" --no-run-reason "$NO_RUN_REASON" \
    --subject-file "$TEXT_DIR/subject.json" \
    --attempt-key "$TEXT_DIR" || exit $?
fi
```

Settle refuses, writing nothing, while the run is still live (collect it
first), for a run of another workflow or phase, and with `DISPATCH_DIR` empty
while a run of this phase is pending (settle that run by its id). Once it has
recorded the attempt, running it again records nothing more.
<!-- pipeline:end critique-review-settle -->

---

## Completion — Active Next-Action Proposal

At the end of a successful critique (both the auto-activated and the
command path above), emit an **Active Next-Action Proposal** instead of a
fixed next verb, per `../_shared/references/entry-routing-contract.md`
§ Active Next-Action Proposal — derived from these findings, not a fixed
table:

```
- selected_next:         <verb | commit | done | owner decision>
- rejected_alternatives: <1-2 alternatives, each + one-line why-not>
- rationale:             <why best — 본질/근본 (essence/foundation) + Standards/Root-Cause gate>
- evidence_pointers:     <phase notes / files / artifacts — pointers only>
- confidence:            <HIGH | MEDIUM | LOW>
- next_command:          <exact next step: /engineer:<verb> … or $engineer:<verb> for a verb; /engineer:commit or $engineer:commit for commit or done; the owner-decision action otherwise>
```

Typical `selected_next` candidates for critique: `/engineer:refine` to
address selected findings (typically CRITICAL + MAJOR; the user picks
which MINOR / SUGGESTION items to include) — or `commit` when no
significant findings surfaced and the artifact is in good shape. The
routing table is the fallback only when evidence is genuinely neutral —
do not end with a hardcoded "next: X". When `selected_next` is
`engineer:decide`, also name the decision size
(`--size=minor|standard|major`) per the contract. The auto-activated path
stays lightweight (ADR-0029 §3): it emits this proposal shape and routing
reasoning without dispatching a peer.

<!-- pipeline:begin critique-finish -->
Run by `/engineer:critique`, the command's last write, `state.mjs
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
`$engineer:critique` on Codex surfaces the footer as
`/engineer:critique` does. Wiring:
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
<!-- pipeline:end critique-finish -->

---

## Multi-axis lens at a 2+-branch point (ADR-0029 §2)

When this verb reaches a **genuine 2+-branch decision point** — two
viable remediation directions, or two severity reads of the same
finding, or a non-neutral `selected_next` with 2+ candidates in the
proposal above — surface a **compact multi-axis lens** comparing the
branches across the decisive axes (본질/근본 essence/foundation) + the
size-appropriate supporting axes, instead of a flat list, per
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

- **Asking the user "is this an issue?"** Validity is the
  orchestrator's judgment. Drop invalid findings; surface valid
  ones by severity.
- **Single-perspective review** when the task's risk profile
  warrants more (e.g., reviewing an auth refactor without a
  `security` perspective).
- **Fixing in the same skill**. Critique produces findings;
  `/engineer:refine` applies fixes.
- **Skipping the peer ensemble** in command mode. Engineer's
  policy is always-max.
- **Surface-level severity inflation**. CRITICAL is reserved for
  defects that block correctness or safety; SUGGESTION is for
  improvements that don't gate merge.
