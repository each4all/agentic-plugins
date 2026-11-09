---
name: compose
description: "Produces the design artifact — user flows, wireframe specs (structure + text, code-first not pixel mockups), CTA copy, information architecture, component specs — each annotated with accessibility + consistency acceptance criteria, from a confirmed UX frame and a chosen direction. The designer persona's composition verb (ADR-0010 §2, ADR-0042 SD2). Use after framing and deciding to draft the design a frontend engineer implements. Trigger phrases include 'draft the flow', 'wireframe this screen', 'write the CTA copy', 'spec this component', 'information architecture', 'design spec', 'lay out this page', '플로우 작성', '와이어프레임', 'CTA 카피', '컴포넌트 스펙', '정보구조', '설계 명세', '구체화해줘'."
---

# Compose (designer persona)

The designer plugin's composition verb (per ADR-0010 §2, ADR-0042 SD2).
Compose produces a **design artifact** — the spec a frontend engineer
implements — from a confirmed UX frame and a chosen direction. This is the
code-first design step: turning a decided direction into explicit,
reviewable flows / wireframe structure / CTA copy / IA / component specs.

| Profile | What it produces |
|---------|------------------|
| `spec` (default) | A **design spec** for the surface: information architecture, the primary user flow, wireframe structure (text-level layout + content blocks), key component specs, and CTA/microcopy — every element annotated with accessibility + consistency acceptance criteria. |
| `flow` | A **user-flow spec**: the task flow with entry points, decision branches, and the full state set per screen (default / loading / empty / error / success), plus the IA the flow traverses. |
| `wireframe` | A **wireframe spec**: per-screen low-fidelity layout described in text (regions, hierarchy, content blocks, primary/secondary actions, CTA copy) — code-first structure, NOT pixel mockups or generated imagery. |

The profile is set via `--profile=<name>` on `/designer:compose`, or
inferred from intent. Missing profile → `spec`. Unknown profile → `spec`
with a one-line warning. The L4 design archetype (general default; ui /
flow / cta / content) flows through the Design Task Profile per
`../investigate/SKILL.md` § Design Task Profile (the shared
`../_shared/references/orchestration.md` reference), not a
per-call flag.

**Code-first, not Figma (ADR-0042).** Compose produces *text/structure* a
frontend engineer implements directly in code — wireframe specs describe
layout and content in words, not pixels. When generated imagery is genuinely
needed (an illustrative hero, an icon set), compose does NOT draw it: it
hands a brief to the `image` L2 capability (`image:compose`) — designer never
re-implements image generation (the artifact-handoff contract lives in
`../_shared/references/orchestration.md` § image L2 composition boundary).

**Quality is annotated in, not deferred (ADR-0042 SD4).** "Excluding Figma
is not excluding quality" means every composed element carries explicit
**acceptance criteria** on the two design-quality axes that the later
`designer:critique` holds the rendered UI to:

- **Accessibility** — candidate WCAG A/AA checks for the element: semantic
  structure / landmark, keyboard operability, visible focus, contrast,
  non-color cues, target size, accessible name. (Candidate-level per
  ADR-0042 Non-Goal 6 — runtime testing certifies conformance.)
- **Consistency** — which design-system component / token / pattern the
  element reuses, and where it deliberately diverges (with the reason).

Pull the measurable UX success metrics straight from the frame so the spec
is held to them (a flow whose frame metric was "≥90% first-time checkout
completion, 0 WCAG A/AA blockers on the primary path" carries those as
acceptance criteria, not as aspirations).

**Core principle**: a spec precedes code. A design spec built on an
unconfirmed frame or an undecided fork is speculation. Compose consumes
upstream output — a confirmed UX problem model from `/designer:frame` and,
when 2+ directions existed, a chosen direction from `/designer:decide`.

**Honest-uncertainty principle**: a spec that marks its unvalidated
assumptions `[to be validated]` (e.g. "assumes users recognize the
hamburger affordance — validate with user-research") is more useful than
one that pretends certainty. Those markers become the user-research /
`designer:investigate` backlog.

---

## When auto-activated (without command)

Lightweight in-context composition — no subagent spawning, no peer ensemble
dispatch.

### Step 1: Profile selection

1. "draft the flow" / "user flow" / "states" → `flow`. "wireframe" /
   "lay out this screen" → `wireframe`. "design spec" / "component spec" /
   "IA" / anything integrated → `spec`.
2. If ambiguous, default to `spec`.

### Step 2: Verify upstream work

Compose consumes a confirmed UX frame from `/designer:frame` (or an
equivalent UX problem model) and a confirmed direction from
`/designer:decide` (when 2+ viable directions existed). If either is
missing, suggest running the upstream verb first rather than composing on
incomplete inputs — composing without a frame produces a generic screen
("a beautiful screen for a task the user never had"); composing through an
undecided fork locks in a pattern the user did not approve.

### Step 3: Produce the artifact

For `spec`, draft each section (IA → flow → wireframe structure → component
specs → CTA/microcopy); for `flow`, map the task flow with the full state
set per screen; for `wireframe`, describe each screen's layout structure and
content blocks in text. **Annotate every element with its accessibility +
consistency acceptance criteria** (the two-bullet block above). Mark every
unvalidated assumption `[to be validated]`. Pull the constraints and
measurable success metrics straight from the frame so the spec stays
consistent with what was framed and decided.

### Step 4: Present and confirm

Follow the Presentation Mode Protocol
(`../_shared/references/presentation-protocol.md`) before presenting.

Present the artifact and confirm before any downstream action. For a
non-trivial spec, present section by section and confirm the flow + the
accessibility acceptance criteria explicitly — they carry the most
load-bearing quality assumptions.

---

## When invoked by command (`/designer:compose` Claude command or `$designer:compose` Codex skill mention)

Full composition with Design Task Profile + peer ensemble + state-write.

### Step 1: Design Task Profile

Build the Design Task Profile per `../investigate/SKILL.md` § Design Task
Profile — Persona=designer, the Surface / Users / Stage / Platform /
Evidence-confidence fields, the verb's Skill-profile
(`spec` / `flow` / `wireframe`), and Ensemble Affinity (recorded, not
gating — always-max policy).

### Step 2: Compose

Produce the artifact per Step 3 above, at command fidelity, with the
accessibility + consistency acceptance criteria on every element.

### Privacy gate (before any external call)

PRIVACY GATE: proprietary UI, unreleased features/flows, customer data
visible in screenshots, and secret-bearing frontend code pass an explicit
privacy gate before BOTH web search AND peer-host dispatch. Genericize
before the peer prompt; the pre-genericization value MUST never leave the
local host. **Screenshots are sensitive by default** and are never sent to
the peer as bytes (the peer path is code/text-based; vision critique is a
same-host `designer:critique` capability). See
`../investigate/references/design-brief-spec.md` § Privacy Gate.

### Step 3: Peer ensemble parallel analysis (Plan-verify point)

Launch the peer ensemble using the **Plan-verify** point type. The
Independence-Rule exception applies (per the engineer Plan-verify
precedent): the peer DOES receive the genericized draft spec as input — its
job is to find gaps in that specific spec (missing states — empty / error /
loading, unhandled edge cases, untested accessibility criteria,
design-system inconsistencies, responsive/RTL gaps, ambiguous CTA copy).
Genericize per the privacy gate before the peer prompt; the peer must never
see proprietary UI or customer data, and screenshots are never sent as
bytes. The peer call is automatic (always-max policy); skills do not pass
`--model` / `--effort`. (designer's `../_shared/references/ensemble-protocol.md`
§Plan-verify carries the prompt template + synthesis
contract; the dispatch shape mirrors the reference-scan dispatch in
`../investigate/references/design-brief-ensemble.md`.)

### Step 4: Synthesize

Incorporate valid gaps (missing states, edge cases). Add peer-surfaced
accessibility/consistency criteria the local pass missed. Note CONFLICT
items for user resolution.

### Step 5: Present

<!-- pipeline:begin compose-present -->
Follow the Presentation Mode Protocol
(`../_shared/references/presentation-protocol.md`) before presenting.

Present the synthesized artifact and confirm before downstream verbs.
<!-- pipeline:end compose-present -->

### State write (when invoked from a workflow command)

<!-- pipeline:begin compose-state-write -->
When `/designer:compose` runs as a sub-step of another designer workflow
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
`/designer:compose`'s finalize settles the attempt, and inside
`/designer:start` or `$designer:start` the lifecycle settles each phase:
skip this step there. On Codex, `$designer:compose` has no command file to
run that finalize (ADR-0013), so when `state.mjs find-active` names an active
designer workflow on this branch, this skill settles the attempt itself,
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
- rationale:             <why best — how the artifact honors the confirmed frame + chosen direction, plus its accessibility + consistency acceptance criteria>
- evidence_pointers:     <spec sections / flow states / brief path — pointers only>
- confidence:            <HIGH | MEDIUM | LOW>
- next_command:          <exact next step: /designer:<verb> … or $designer:<verb> for a verb; the owner's save and commit for commit; none for done; the owner's decision otherwise>
```

Typical `selected_next` candidates for compose: `/designer:critique` to
evaluate the spec (and, once built, the rendered screen) against the
accessibility + consistency + usability criteria — or `/designer:decide` if
composing surfaced an undecided fork, or `/designer:investigate` if a
load-bearing pattern assumption needs evidence before the spec is
trustworthy. The routing is a fallback only when evidence is genuinely
neutral — do not end with a hardcoded "next: X".

**Surface note (ADR-0042 Accepted).** The full designer surface ships: the
six cognitive verbs (`investigate` / `frame` / `decide` / `compose` /
`critique` / `refine`), the `/designer:start` lifecycle macro, and the
`resume` / `checkpoint` / `peer-now` meta skills. Every `next_command` this
proposal can name is runnable. The composed spec is the durable handoff.

Always include the workflow path when invoked from a workflow command:

```
Workflow: <absolute path to workflow .md file>
```

<!-- pipeline:begin compose-finish -->
Run by `/designer:compose`, the command's last write, `state.mjs
finish-verb`, records this proposal's closed-enum form — `next_step_kind`,
`next_step_verb` and `next_step_confidence` (ADR-0063 D6;
`../_shared/references/entry-routing-contract.md` § Active Next-Action
Proposal); the fields are host-shared. Unless it ends with an owner gate, that
write is terminal. Inside `/designer:start` no phase makes a verb's
terminal write: the lifecycle makes its one terminal write at its end. A
standalone skill invocation writes no workflow state and emits no footer.
The owner gates, and the step that resolves each:
`../_shared/references/entry-routing-contract.md` § Owner gates.

The runtime completion footer is **code-emitted** on that terminal write
(ADR-0039): its completion state is
`publish-needed` when only the owner's save and commit remain, since
designer runs no commit itself.
The write fires the session-handoff sidecar, which renders the runtime
`footer.mjs`, the ADR-0031 continue-vs-fresh session handoff included, on that
command's stderr. Do not hand-compose a second footer or hand-pass the
projection; surface the emitted one. On a detached HEAD the branch-based
preflight reports "no active branch context" and never recommends a fresh
session (ADR-0018 §sub-2); the path-targeted terminal sidecar renders the
footer as on a branch, its continue-vs-fresh advice included.
`$designer:compose` on Codex surfaces the footer as
`/designer:compose` does. Wiring:
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
layout structures, two flow shapes, two component approaches — surface a
**compact multi-axis lens** comparing the branches across the decisive
design axes (사용성 Usability + the archetype axis) + the accessibility gate,
instead of a flat list, reading the resolved axes from
`../decide/references/decision-axes.yml` (the `scripts/decide-registry.mjs
resolve` resolver, with the active profile in `AGENTIC_DESIGNER_PROFILE` and
no `--size`, gives the profile's preset:
`../_shared/references/entry-routing-contract.md` § Surfacing the multi-axis
lens from a non-decide verb). Bounded: only at a genuine 2+-branch
point, never the full matrix for a trivial reversible step. A weightier fork
should route to `/designer:decide` rather than be settled inline.

---

## Anti-patterns (do not produce)

- **Composing without a confirmed frame**. A spec without a frame hides the
  assumption that the UX problem is obvious — the "beautiful screen, no real
  task" failure mode.
- **Composing through an undecided fork** ("I'll pick the pattern as I go").
  Forks belong to `/designer:decide`; composing through them locks in an
  unapproved pattern.
- **Deferring quality instead of annotating it**. Every element carries its
  accessibility + consistency acceptance criteria in the spec — "we'll check
  a11y later" is the failure mode SD4 exists to prevent.
- **Pixel mockups / generated imagery inline**. Wireframe specs are
  text/structure (code-first); generated imagery is an `image:compose`
  handoff, never drawn here.
- **Skipping the peer ensemble** in command mode. designer's policy is
  always-max — the peer exists to catch the missing state (empty / error)
  or the untested accessibility criterion.
- **Fabricated certainty on assumptions**. Mark unvalidated pattern/user
  assumptions `[to be validated]`; never present an assumed user behavior as
  evidenced.
- **Leaking proprietary material** to the peer or to web search. Genericize
  the spec and any customer/user data before any external call; screenshots
  are sensitive by default and never sent as bytes.
- **Certifying accessibility conformance**. The acceptance criteria flag
  *candidate* WCAG A/AA checks; conformance needs runtime testing (focus
  order, keyboard, screen-reader) per ADR-0042 Non-Goal 6.
