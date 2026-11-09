---
name: compose
description: "Produces the business planning artifact — a venture plan, a lean/business-model canvas, or a validation/experiment plan — from a confirmed opportunity frame and a chosen direction. The founder persona's composition verb (기획구상, ADR-0010 §2 / ADR-0036 SD2). Use after framing and deciding to actually draft the plan. Trigger phrases include 'write the business plan', 'draft the plan', 'put together the venture plan', 'make a lean canvas', 'business model canvas', 'validation plan', 'what should we test next', 'go-to-market plan', '사업계획서', '기획안 작성', '린 캔버스', '검증 계획', '계획 세워줘', '구체화해줘'."
---

# Compose (founder persona)

The founder plugin's composition verb (per ADR-0010 §2, ADR-0036 SD2).
Compose produces a **business planning artifact** from a confirmed
opportunity frame and a chosen direction. This is the planning step
(기획구상): turning a validated direction into an explicit, reviewable plan.

| Profile | What it produces |
|---------|------------------|
| `plan` (default) | A structured **venture plan**: problem/opportunity, customer + JTBD, value proposition, market, business model, unit economics, go-to-market, milestones, key risks + mitigations, validation backlog. |
| `canvas` | A one-page **lean / business-model canvas** (problem, solution, key metrics, unique value proposition, unfair advantage, channels, customer segments, cost structure, revenue streams). |
| `validation-plan` | A **validation / experiment plan**: riskiest assumptions → cheapest test for each → success criteria → decision rule (pivot / persevere / kill). |

The profile is set via `--profile=<name>` on `/founder:compose`, or
inferred from intent. Missing profile → `plan`. Unknown profile → `plan`
with a one-line warning. The L4 business-model archetype (general default;
b2b-saas / consumer-app / commerce / content with demand) flows through the
Business Task Profile per `../_shared/references/orchestration.md`, not a
per-call flag.

**Core principle**: a plan precedes commitment. A venture plan built on an
unconfirmed frame or an undecided fork is speculation. Compose consumes
upstream output — a confirmed opportunity model from `/founder:frame` and,
when 2+ directions existed, a chosen direction from `/founder:decide`.

**Honest-uncertainty principle**: a plan that marks its unverified
assumptions `[to be validated]` is more useful than one that pretends
certainty. Every revenue, cost, and demand number that is not yet evidenced
carries the marker — and those markers become the `validation-plan`
backlog. founder does not manufacture false confidence in a financial
projection.

---

## When auto-activated (without command)

Lightweight in-context composition — no subagent spawning, no peer ensemble
dispatch.

### Step 1: Profile selection

1. "draft the plan" / "business plan" → `plan`. "lean canvas" /
   "business model canvas" → `canvas`. "what should we test" / "validation
   plan" → `validation-plan`.
2. If ambiguous, default to `plan`.

### Step 2: Verify upstream work

Compose consumes a confirmed problem frame from `/founder:frame` (or an
equivalent opportunity model) and a confirmed direction from
`/founder:decide` (when 2+ viable directions existed). If either is
missing, suggest running the upstream verb first rather than composing on
incomplete inputs — composing without a frame produces a generic plan;
composing through an undecided fork locks in a choice the user did not
approve.

### Step 3: Produce the artifact

For `plan`, draft each section; for `canvas`, fill each box; for
`validation-plan`, list assumptions ranked by risk with the cheapest test
+ success criterion + decision rule for each. Mark every unverified number
or claim `[to be validated]`. Pull the unit-economics direction and the
key risks straight from the frame / decision so the plan stays consistent
with what was decided.

### Step 4: Present and confirm

Follow the Presentation Mode Protocol
(`../_shared/references/presentation-protocol.md`) before presenting.

Present the artifact and confirm before any downstream action. For a
non-trivial plan, present section by section and confirm the
business-model + unit-economics sections explicitly — they carry the most
load-bearing assumptions.

---

## When invoked by command (`/founder:compose` Claude command or `$founder:compose` Codex skill mention)

Full composition with Business Task Profile + peer ensemble + state-write.

### Step 1: Business Task Profile

Build the Business Task Profile per `../_shared/references/orchestration.md`
Step 1 — Persona=founder, the Market / Segment / Stage / Risk-class /
Evidence-confidence fields, and the verb's Skill-profile
(`plan` / `canvas` / `validation-plan`).

### Step 2: Compose

Produce the artifact per Step 3 above, at command fidelity.

### Step 3: Peer ensemble parallel analysis (Plan-verify point)

Launch the peer ensemble using the **Plan-verify** point type. The
Independence-Rule exception applies (per the engineer Plan-verify
precedent): the peer DOES receive the genericized draft plan as input — its
job is to find gaps in that specific plan (missing risks, unsupported
unit-economics, sequencing problems, untested assumptions). Genericize per
the privacy gate before the peer prompt; the peer must never see
proprietary venture concepts or customer data. The peer call is automatic
(always-max policy); skills do not pass `--model` / `--effort`. (founder's
`../_shared/references/ensemble-protocol.md` §Plan-verify carries the
prompt template + synthesis contract; the concrete dispatch bash lives in
`commands/compose.md` and mirrors the research-scan dispatch in
`../investigate/references/business-brief-ensemble.md`.)

### Step 4: Synthesize

Incorporate valid gaps. Adjust sequencing for valid ordering issues. Add
peer-surfaced risks/assumptions to the plan and its validation backlog.
Note CONFLICT items for user resolution.

### Step 5: Present

<!-- pipeline:begin compose-present -->
Follow the Presentation Mode Protocol
(`../_shared/references/presentation-protocol.md`) before presenting.

Present the synthesized artifact and confirm before downstream verbs.
<!-- pipeline:end compose-present -->

### State write (when invoked from a workflow command)

<!-- pipeline:begin compose-state-write -->
When `/founder:compose` runs as a sub-step of another founder workflow
command, the invoking command writes the artifact + progress to its workflow
file.
This skill itself does not write workflow state. When invoked
standalone, no workflow file write occurs.
<!-- pipeline:end compose-state-write -->

<!-- pipeline:begin compose-review-settle -->
**On Codex, the skill settles its review (C163 A1a).** Besides the
workflow writes the state-write note above names, on Codex this skill also
settles its review in the workflow. A review leaves one outcome per attempt in the
workflow (ADR-0023, implementation note of 2026-11-05), and it is the settle
that records it. On Claude,
`/founder:compose`'s finalize settles the attempt, and inside
`/founder:start` or `$founder:start` the lifecycle settles each phase:
skip this step there. On Codex, `$founder:compose` has no command file to
run that finalize (ADR-0013), so when `state.mjs find-active` names an active
founder workflow on this branch, this skill settles the attempt itself,
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

At the end of a successful compose (both paths), emit an **Active
Next-Action Proposal** instead of a fixed next verb — derived from this
artifact, not a fixed table:

```
- selected_next:         <verb | commit | done | owner decision>
- rejected_alternatives: <1-2 alternatives, each + one-line why-not>
- rationale:             <why best — 본질/근본 (essence/foundation) + evidence-quality gate>
- evidence_pointers:     <plan sections / brief path — pointers only>
- confidence:            <HIGH | MEDIUM | LOW>
- next_command:          <exact next step: /founder:<verb> … or $founder:<verb> for a verb; the owner's save and commit for commit; none for done; the owner's decision otherwise>
```

Typical `selected_next` candidates for compose: `/founder:critique` to
review the plan — or `/founder:decide` if composing
surfaced an undecided fork, or `/founder:investigate` if a load-bearing
assumption needs evidence before the plan is trustworthy. The routing is a
fallback only when evidence is genuinely neutral — do not end with a
hardcoded "next: X".

<!-- pipeline:begin compose-finish -->
Run by `/founder:compose`, the command's last write, `state.mjs
finish-verb`, records this proposal's closed-enum form — `next_step_kind`,
`next_step_verb` and `next_step_confidence` (ADR-0063 D6;
`../_shared/references/entry-routing-contract.md` § Active Next-Action
Proposal); the fields are host-shared. Unless it ends with an owner gate, that
write is terminal. Inside `/founder:start` no phase makes a verb's
terminal write: the lifecycle makes its one terminal write at its end. A
standalone skill invocation writes no workflow state and emits no footer.
The owner gates, and the step that resolves each:
`../_shared/references/entry-routing-contract.md` § Owner gates.

The runtime completion footer is **code-emitted** on that terminal write
(ADR-0039): its completion state is
`publish-needed` when only the owner's save and commit remain, since
founder runs no commit itself.
The write fires the session-handoff sidecar, which renders the runtime
`footer.mjs`, the ADR-0031 continue-vs-fresh session handoff included, on that
command's stderr. Do not hand-compose a second footer or hand-pass the
projection; surface the emitted one. On a detached HEAD the branch-based
preflight reports "no active branch context" and never recommends a fresh
session (ADR-0018 §sub-2); the path-targeted terminal sidecar renders the
footer as on a branch, its continue-vs-fresh advice included.
`$founder:compose` on Codex surfaces the footer as
`/founder:compose` does. Wiring:
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

When composing reaches a **genuine 2+-branch decision point** — two viable
plan structures, two go-to-market wedges, two pricing models — surface a
**compact multi-axis lens** comparing the branches across the decisive
business axes (시장성 / 단위경제) + the gates, instead of a flat list, reading
`../decide/references/decision-axes.yml` (the `--size=minor` compact
4-axis set). Bounded: only at a genuine 2+-branch point. A weightier fork
should route to `/founder:decide` rather than be settled inline.

---

## Anti-patterns (do not produce)

- **Composing without a confirmed frame**. A plan without a frame hides the
  assumption that the opportunity is obvious — the "great plan for a market
  that does not exist" failure mode.
- **Composing through an undecided fork** ("I'll figure out the model as I
  go"). Forks belong to `/founder:decide`; composing through them locks in
  an unapproved choice.
- **Skipping the peer ensemble** in command mode. founder's policy is
  always-max — the peer exists to catch the missing risk or the
  unsupported unit-economics line.
- **Fabricated confidence on financials**. Mark unverified revenue / cost /
  demand numbers `[to be validated]`; never present a projection as
  evidenced when it is an assumption.
- **Leaking proprietary material** to the peer or to web search. Genericize
  the plan and any customer/interview data before any external call.
- **Professional-advice claims**. founder does not produce legal,
  financial, tax, or clinical advice (ADR-0036 Non-Goal 6); flag
  regulated-domain plan sections as needing a qualified professional.
