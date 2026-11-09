---
name: refine
description: "Applies critique findings or feedback to a design artifact — revises the user flow, wireframe spec, CTA copy, component spec, or the frontend code + rendered screen, then re-critiques to confirm the change converges without introducing a new accessibility barrier. The designer persona's refinement verb (ADR-0010 §2, ADR-0042 SD4 convergence loop). Use after a critique to apply the findings, or to iterate a design toward convergence. Trigger phrases include 'apply the findings', 'address the review', 'fix this screen', 'revise the flow', 'incorporate the feedback', 'tighten the CTA', 'fix the a11y issues', 'apply the critique', 'iterate on this design', '리뷰 반영', '피드백 반영', '이 화면 고쳐줘', '플로우 수정', '지적 반영', '접근성 고쳐줘', '디자인 보완해줘'."
---

# Refine (designer persona)

The designer plugin's refinement verb (per ADR-0010 §2, ADR-0042 SD4). Refine
applies critique findings or feedback to an existing **design artifact** — a
pre-code design spec (user flow, wireframe spec, CTA copy, information
architecture, component spec) OR a post-code surface (the frontend code + the
rendered screen) — and verifies the revision holds together. Refine assumes the
*what to change* is known; the work is applying it faithfully and confirming the
design still reconciles. The user is the decision-maker; this verb maximizes the
fidelity and honesty of the revision, not the automation of the change.

Refine closes designer's **quality loop** (ADR-0042 SD4 item 5): the signature
shape is **critique → refine → re-critique until findings converge** (the
engineer Phase 5–6 convergence pattern, copied). A refinement is not "done" when
the edit lands — it is done when a re-critique of the revised artifact confirms
the finding is resolved and no new barrier was opened.

This verb takes no `--profile` argument — refine is **single-mode by design**
(the verb's purpose is faithful application + verification of an already-decided
change). The L4 design archetype (general default; ui / flow / cta / content)
flows through the Design Task Profile per `../investigate/SKILL.md` § Design Task
Profile (the shared `../_shared/references/orchestration.md` reference), not via
a per-call profile argument.

**Core principle**: do not revise the design until the *why* is confirmed. When
refining in response to a critique or a usability/conversion problem, the
upstream contract is:

```
critique  (or investigate for a load-bearing evidence gap)
   →  decide  (if 2+ viable remediation directions)
   →  refine
```

Skipping critique/investigate produces revisions that paper over the symptom (a
low-contrast CTA "fixed" by a color the design system does not sanction).
Skipping decide when 2+ remediation directions exist locks in an undeliberated
change (choosing a modal over an inline form without weighing the flow).

**Verify means the design still reconciles, not "run tests".** A design artifact
is held to its own acceptance criteria, not a unit-test suite:

- Do the revised elements still carry their **accessibility + consistency
  acceptance criteria** (the two-bullet block `/designer:compose` annotates in)?
- Does the revised flow still honor the frame's **measurable UX success
  metrics**, or did the change quietly trade one away?
- Are still-unvalidated assumptions still marked `[to be validated]` — a revision
  must not silently upgrade an assumption to a fact to make the design look more
  certain.
- **Did the change open a new accessibility barrier?** This is the load-bearing
  design gate: a revision that clears a usability or conversion problem by
  introducing a candidate WCAG A/AA barrier (contrast, semantic structure,
  visible focus, target size, non-color cue, accessible name) has **moved the
  veto gate, not cleared it**. Surface the new exposure; never bury it.

For a **post-code** revision (a frontend-code edit + the re-rendered screen), the
verification can additionally read the **re-rendered screen host-direct**
(same-host vision). designer does **not** run the frontend build — the re-rendered
screen is the one the user / frontend engineer supplies after rebuilding. If that
screen is unavailable, or the edit broke the render, the vision re-critique cannot
run: report the code/text verification only, flag the visual re-critique
**UNVERIFIED**, and do not claim full convergence. The candidate-only
accessibility boundary still holds either way (ADR-0042 Non-Goal 6): focus order,
keyboard traversal, and screen-reader behavior need runtime interaction testing a
static re-critique cannot certify.

---

## When auto-activated (without command)

Lightweight in-context refinement — no peer ensemble dispatch, no subagents.

### Step 1: Verify upstream

Before revising, confirm the basis for the change:

- For critique-driven changes: a finding list from `/designer:critique` (or an
  equivalent feedback document).
- For evidence-gap changes: a load-bearing convention / accessibility claim
  confirmed via `/designer:investigate`. If a claim the revision rests on is
  unverified, suggest investigating first rather than guessing.
- For direction-driven changes: the direction is confirmed via `/designer:decide`
  (when 2+ viable remediation directions existed).

If multiple findings are pending, present them as a list and confirm with the
user which to address now (all? the CRITICAL + MAJOR set? a subset? defer the
rest?).

### Step 2: Apply the revision

For each item being addressed:

1. State the change before applying it: "Plan: revise the `<flow/screen/element>`
   to <action> because <finding>."
2. Apply the change to the artifact (the spec text, or the frontend code).
3. If the change is non-trivial (it touches a primary flow, a CTA, a gate-relevant
   accessibility criterion, or a shared component), present the before→after and
   confirm before moving on.

When the remediation involves 2+ viable directions, do NOT choose silently —
route through `/designer:decide` first.

### Step 3: Verify the design reconciles (+ the re-critique)

1. Re-read the elements downstream of the change. Confirm they still reconcile
   (a revised layout still satisfies the flow's states — default / loading /
   empty / error / success; a revised CTA still matches the IA and the value
   proposition).
2. Confirm the change did not open a **new accessibility barrier** (the gate
   above). A revision that solves a usability/conversion problem by introducing a
   candidate WCAG A/AA barrier has moved the gate, not cleared it.
3. Confirm every still-unvalidated assumption keeps its `[to be validated]`
   marker, and the revised flow still honors the frame's measurable success
   metrics.
4. **Re-critique** the revised artifact (the convergence step): re-apply the
   relevant `/designer:critique` lenses (usability / accessibility / conversion /
   consistency) to the change. For a post-code revision, read the re-rendered
   screen host-direct **when the user / frontend engineer supplies it** (designer
   does not run the build); if it is unavailable or the edit broke the render, the
   vision re-critique cannot run — flag it UNVERIFIED and do not claim convergence.
   Loop back to Step 2 for any new finding until findings converge — no new
   CRITICAL / MAJOR and the accessibility gate is **not FAIL** (see
   @refine:convergence-predicate). **Bound the loop**: at most
   a few passes (default 2, hard cap 3); if findings still do not converge, stop
   and pause (route to `/designer:decide` / `/designer:investigate` / an owner
   decision) rather than iterating indefinitely.

<!-- @refine:convergence-predicate:begin -->
**The convergence predicate.** A refinement has converged when the re-critique
produces **no new CRITICAL / MAJOR finding** and the accessibility gate verdict
is **not `FAIL`** — that is, `PASS`, or `CONDITIONAL` with every remediation
named as a blocking precondition of the artifact.

`CONDITIONAL` converges **on purpose**. Under ADR-0042 Non-Goal 6 a static
spec / code / screenshot critique is candidate-level and cannot certify
conformance: focus order, keyboard traversal, and screen-reader behavior are
established only by runtime testing, which designer does not perform. So a
correct, well-specified design that names its runtime-verifiable remediations
lands on `CONDITIONAL`, not `PASS`. Requiring `PASS` to converge would mean an
honest design never converges — and would pressure the author into the exact
over-claim Non-Goal 6 exists to prevent.

What does **not** converge: a `FAIL` gate (an unmitigated candidate barrier), a
`CONDITIONAL` whose remediation is vague, deferred, or unowned ("we'll check
contrast later" is not a precondition), and any pass that opens a new barrier.
<!-- @refine:convergence-predicate:end -->

If verification surfaces a new inconsistency or a new barrier, return to Step 2
and report it. Do NOT mark the refinement complete on an unreconciled artifact or
an unresolved re-critique.

### Step 4: Present the result

Follow the Presentation Mode Protocol
(`../_shared/references/presentation-protocol.md`) before presenting.

```
## Refinement Summary
- Applied: [N findings / 1 revision / etc.]
- Verified: [downstream elements reconcile; accessibility gate exposure
  unchanged or reduced; measurable success metrics intact; [to be validated] markers intact]
- Re-critique: [converged — no new CRITICAL/MAJOR, gate PASS or CONDITIONAL
  with named preconditions] OR [new findings → looping] OR [paused — gate FAIL
  / pass cap reached]
- Deferred: [items not addressed and why]
```

If findings remain, that informs the Active Next-Action Proposal at completion —
typically `/designer:critique` again on the revised artifact (the re-critique
handoff) to confirm the change did not expose a new weakness.

---

## When invoked by command (`/designer:refine` Claude command or `$designer:refine` Codex skill mention)

Full refinement with Design Task Profile + peer ensemble verification + state-write.

### Step 1: Design Task Profile

Build the Design Task Profile per `../investigate/SKILL.md` § Design Task Profile
(Persona=designer; Surface / Users / Stage / Platform / Evidence-confidence
fields; Ensemble Affinity recorded but not gating — always-max policy). Refine is
single-mode, so there is no verb Skill-profile to record. The shared
`../_shared/references/orchestration.md` Dynamic Orchestration reference is the
canonical source.

### Step 2: Apply the revision

Follow Step 2 above, at command fidelity. When the change is non-trivial, apply
it element by element, confirming the accessibility acceptance criteria
explicitly — they carry the most load-bearing quality assumptions.

### Step 3: Privacy gate (before any external call)

<!-- pipeline:begin refine-privacy-gate -->
PRIVACY GATE: proprietary UI, unreleased features/flows, customer data visible in screenshots, and secret-bearing frontend code
pass an explicit privacy gate before BOTH web search AND peer-host dispatch.
Genericize the revision before the peer prompt; the pre-genericization value MUST never leave the local host.
See `../investigate/references/design-brief-spec.md` § Privacy Gate.
<!-- pipeline:end refine-privacy-gate -->

<!-- pipeline:begin refine-privacy-no-image -->
No dispatch passes `--image`: the companion peer path has no image channel, so
an image never reaches the peer as bytes.
<!-- pipeline:end refine-privacy-no-image -->

**Screenshots are sensitive by default** — a rendered screen is re-critiqued
same-host (Claude natively; Codex via `codex exec --image`) and is **never sent
to the peer as inline image bytes**; the peer path is code/text-based, or a
verified-local absolute file path the peer reads on its own host. When
confidentiality is unclear, ask the user, or run **local-only** (skip the peer).

### Step 4: Peer ensemble parallel verification (Refine-verify point type)

Launch the peer ensemble (always-max policy; never ask the user, never direct
them to run companion CLIs manually) using the **Refine-verify** ensemble point
type. The peer receives the **genericized** before→after of the changed
elements — spec text and/or frontend code, or a verified-local screenshot path,
**never image bytes** — and independently verifies the revision resolves the
finding without introducing a new inconsistency or a new accessibility barrier.
Build the Refine-verify prompt, write it with the file-writing tool into a private directory (`mktemp -d "${TMPDIR:-/tmp}/agentic-text.XXXXXX"`) as `prompt.xml`, never through the shell (ADR-0059, amendment of 2026-10-10), and dispatch it with
`--prompt-file` in the background. The prompt template + synthesis contract land in
`../_shared/references/ensemble-protocol.md` § Refine-verify; the dispatch
shape mirrors the reference-scan dispatch in
`../investigate/references/design-brief-ensemble.md` (command-managed via
`scripts/peer-runner.mjs`). See `commands/refine.md` for the concrete dispatch
bash.

The peer's core contribution is the code/text perspective (semantic structure,
naming, pattern/token conformance, copy, funnel logic). By default it receives no
screenshot, so the vision-grounded re-critique of the re-rendered screen
(contrast as-rendered, visual hierarchy, spacing) is the same-host model's
responsibility **when the re-rendered screen is available** (designer does not run
the build — the user / frontend engineer supplies it; an unavailable or broken
re-render leaves the visual re-critique UNVERIFIED, not converged); no inline image
bytes ever reach the peer.

### Step 5: Synthesize + converge

Follow the Presentation Mode Protocol
(`../_shared/references/presentation-protocol.md`) before presenting.

After both sides return:

1. Re-check that the design reconciles (Step 3 of auto-activated mode), including
   the accessibility gate-exposure check.
2. Collect the peer verification.
3. Synthesize per AGREED / LOCAL-ONLY / PEER-ONLY / CONFLICT. Label discovery
   side (`[Local]` / `[Peer]` / `[Both]`) in workflow phase notes only — never in
   a saved artifact.
4. Resolve any new findings:
   - Straightforward → apply inline (return to Step 2).
   - 2+ viable remediation directions → route through `/designer:decide`.
   - A peer-flagged regression (a new inconsistency or a **new accessibility
     barrier**) → pause and report to the user before proceeding.

Loop Steps 2–5 until findings converge per @refine:convergence-predicate (no
new CRITICAL / MAJOR and the accessibility gate is not FAIL). This is the
critique → refine → re-critique
convergence loop. **Bound it (no unbounded loop)**: run at most a few passes
(default 2, hard cap 3). If findings still do not converge — each pass exposes a
fresh CRITICAL / MAJOR, or the peer keeps flagging a regression — STOP: pause and
route to an owner decision (a 2+-direction remediation fork → `/designer:decide`;
a load-bearing unverified claim → `/designer:investigate`; otherwise present the
residual findings for the owner to weigh). A paused refine is left unresolved on
purpose — it is not marked complete.

<!-- pipeline:begin refine-pass-settle -->
**Each pass settles its own run (C163 A1a).** Every refine-verify a pass
runs, or would have run, is a review attempt of its own, and the workflow
keeps one outcome per attempt (ADR-0023, implementation note of 2026-11-05).
The finalize settles the last pass's attempt only: on Claude
`/designer:refine`'s Phase 2, inside a `/designer:start` or
`$designer:start` lifecycle its refine phase, and on Codex this skill's
settle step below. So when the loop goes back to Step 2, settle the pass just
done first, once its synthesis is done, with the block below, whether it
launched a run or not; leave the last pass, launched or not, to the finalize.
Left unsettled, an earlier pass's launched run stays an open attempt that
reads `unknown`, its pending row stays, and settle refuses every later settle
of phase refine that names no run; an earlier pass that launched no run (the
peer not found, the privacy gate, a local-only pass) leaves no attempt at
all. With no active designer workflow on this branch there is nothing to
settle, and the block says so.

Write the pass's one-line synthesis résumé as `summary.txt` in a new
`mktemp -d "${TMPDIR:-/tmp}/agentic-text.XXXXXX"` directory with your
file-writing tool, not the shell (ADR-0059, amendment of 2026-10-10): that
directory is `TEXT_DIR`, a new one for each pass. Set `HOST` to the host you
run on, `claude` or `codex`, and fill `<plugin-root>` with this plugin's
installed root, the path you read this SKILL.md from, cut before its
`/core/skills/` directory. Then:

- a pass that launched a run: give its dispatch its own directory, as the
  dispatch step says; that directory, holding the runner's
  `prompt.xml.run.json`, is `DISPATCH_DIR`. Set `VERDICT` to the pass's
  synthesis verdict, one word: `resolved`, `concerns`, `regression` or
  `conflict`, or `degraded` when the answer parses to nothing usable or the
  run failed (settle records `failed`, `unavailable` or `malformed` from the
  ledger whatever the verdict). Leave `NO_RUN_REASON` empty.
- a pass that launched no run: `DISPATCH_DIR` and `VERDICT` empty, and
  `NO_RUN_REASON` why: `peer-unavailable` (the companion or the peer's CLI
  was not found before any run), `local-only`, `privacy-gate` (the prompt
  could not be made safe to send) or `owner-skip`. The attempt is recorded
  `unavailable` or `skipped` under an id derived from `TEXT_DIR`, so a rerun
  of the block with the same `TEXT_DIR` records it once.

A value left unfilled, an empty `TEXT_DIR`, another host, another verdict or
reason, a verdict with no run, a reason beside a run, and neither a run nor a
reason each stop the block before any write.

```bash
TEXT_DIR='<the directory holding this pass summary.txt>'
DISPATCH_DIR='<the directory this pass dispatch ran with; empty when the pass launched no run>'
VERDICT='<this pass synthesis verdict; empty when the pass launched no run>'
# Why the pass launched no run (peer-unavailable, local-only, privacy-gate or
# owner-skip); empty when it launched one.
NO_RUN_REASON=''
HOST='<claude or codex, the host you run on>'
case "$HOST" in
  claude|codex) ;;
  *) echo "✗ HOST is not claude or codex, the host you run on; nothing was settled." >&2; exit 1 ;;
esac
case "$NO_RUN_REASON" in
  ''|peer-unavailable|local-only|privacy-gate|owner-skip) ;;
  *) echo "✗ NO_RUN_REASON is not peer-unavailable, local-only, privacy-gate or owner-skip (empty when the pass launched a run); nothing was settled." >&2; exit 1 ;;
esac
# A placeholder left as written opens with "<"; a directory mktemp printed
# is an absolute path, which never does, whatever it holds further on.
case "$TEXT_DIR" in
  ''|'<'*) echo "✗ TEXT_DIR is empty or not filled in; nothing was settled." >&2; exit 1 ;;
esac
case "$DISPATCH_DIR" in
  '<'*) echo "✗ DISPATCH_DIR is not filled in (empty when the pass launched no run); nothing was settled." >&2; exit 1 ;;
esac
if [ -n "$DISPATCH_DIR" ]; then
  [ -z "$NO_RUN_REASON" ] || { echo "✗ NO_RUN_REASON is set, but DISPATCH_DIR names a run the pass launched: empty one or the other; nothing was settled." >&2; exit 1; }
  # The pass's verdict, one of the words a refine synthesis uses: another word
  # would record a clean pass failed (unrecognized-verdict).
  case "$VERDICT" in
    resolved|concerns|regression|conflict|degraded) ;;
    *) echo "✗ VERDICT is not resolved, concerns, regression, conflict or degraded, the words a refine synthesis uses; nothing was settled." >&2; exit 1 ;;
  esac
else
  [ -z "$VERDICT" ] || { echo "✗ VERDICT is set, but DISPATCH_DIR is empty (no run launched, so there is no verdict): empty one or set the other; nothing was settled." >&2; exit 1; }
  [ -n "$NO_RUN_REASON" ] || { echo "✗ DISPATCH_DIR and NO_RUN_REASON are both empty: a pass that launched no run names why; nothing was settled." >&2; exit 1; }
fi
# A fresh shell: the workflow is found again here. With none on this branch
# there is nothing to settle.
REPO_ROOT="$(git rev-parse --show-toplevel)" || exit 1
ACTIVE="$(node "<plugin-root>/scripts/state.mjs" find-active --repo-root "$REPO_ROOT")" || exit $?
[ -n "$ACTIVE" ] || { echo "No active workflow on this branch: no review attempt to settle." >&2; exit 0; }
if [ -n "$DISPATCH_DIR" ]; then
  # The run's id, from the result the runner wrote beside the prompt, never
  # retyped: a well-formed run id (letters, digits, ".", "_", ":", "-", no "..").
  RUN_ID="$(node -e 'const fs=require("fs"),p=require("path");let r;try{r=JSON.parse(fs.readFileSync(p.join(process.argv[1],"prompt.xml.run.json"),"utf8"))}catch{process.exit(1)}const id=r&&r.run_id;if(typeof id!=="string"||!/^[A-Za-z0-9._:-]+$/.test(id)||id.includes(".."))process.exit(1);process.stdout.write(id)' "$DISPATCH_DIR")" \
    || { echo "✗ prompt.xml.run.json in DISPATCH_DIR ($DISPATCH_DIR) names no run id (a runner killed before it wrote its result leaves it empty): settle that run by hand, peer-runner.mjs settle --repo-root <the repository root> --workflow-path <the active workflow> --phase refine --run-id <the id the dispatch passed as --run-id>. Nothing was settled." >&2; exit 1; }
  node "<plugin-root>/scripts/peer-runner.mjs" settle --repo-root "$REPO_ROOT" \
    --workflow-path "$ACTIVE" --host "$HOST" --phase refine --run-id "$RUN_ID" \
    --verdict "$VERDICT" --summary-file "$TEXT_DIR/summary.txt" || exit $?
else
  node "<plugin-root>/scripts/peer-runner.mjs" settle --repo-root "$REPO_ROOT" \
    --workflow-path "$ACTIVE" --host "$HOST" --phase refine --run-id '' \
    --ensemble-type refine-verify --no-run-reason "$NO_RUN_REASON" \
    --attempt-key "$TEXT_DIR" || exit $?
fi
```

Settle refuses, writing nothing, while the run is still live (collect it
first), for a run of another workflow or phase, and with `DISPATCH_DIR` empty
while a run of phase refine is pending (settle that run by its id). Once it
has recorded the attempt, running it again records nothing more. The
finalize is for the last pass only: it settles a run it names again without
harm, but a pass that launched no run, settled here and again by the
finalize from its own text directory, would be recorded twice.
<!-- pipeline:end refine-pass-settle -->

### State write (when invoked from a workflow command)

When `/designer:refine` runs as a sub-step of a designer workflow command (the
`/designer:start` lifecycle macro), the invoking command writes the
applied revision (element, summary) and the verification result (design
reconciles, gate exposure unchanged, peer verdict, re-critique convergence) to
its workflow file. This skill itself writes no phase note; its own workflow
writes are the settles of its refine-verify attempts: each earlier pass's,
launched or not (the pass settle above) and, on Codex, the last pass's (the
settle step below). When invoked standalone, no workflow file write occurs.

<!-- pipeline:begin refine-review-settle -->
**On Codex, the skill settles its review (C163 A1a).** Besides the
workflow writes the state-write note above names, on Codex this skill also
settles its review in the workflow. A review leaves one outcome per attempt in the
workflow (ADR-0023, implementation note of 2026-11-05), and it is the settle
that records it. On Claude,
`/designer:refine`'s finalize settles the attempt, and inside
`/designer:start` or `$designer:start` the lifecycle settles each phase:
skip this step there. On Codex, `$designer:refine` has no command file to
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
`--kind ensemble --workflow-path <the active workflow> --phase refine
--ensemble-type <type> --host codex --run-id <id>`, the id printed by
`peer-runner.mjs new-run-id --prefix <type>`, and the type `refine-verify`.
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
  `resolved`, `concerns`, `regression` or `conflict`,
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
ENSEMBLE_TYPE='refine-verify'
# Why no run launched (peer-unavailable, local-only, privacy-gate or
# owner-skip); empty when a run launched.
NO_RUN_REASON=''
case "$ENSEMBLE_TYPE" in
  'refine-verify'|'refine-verify') ;;
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
    --workflow-path "$ACTIVE" --host codex --phase 'refine' --run-id "$RUN_ID" \
    --verdict "$VERDICT" --summary-file "$TEXT_DIR/summary.txt" || exit $?
else
  node "<plugin-root>/scripts/peer-runner.mjs" settle --repo-root "$REPO_ROOT" \
    --workflow-path "$ACTIVE" --host codex --phase 'refine' --run-id '' \
    --ensemble-type "$ENSEMBLE_TYPE" --no-run-reason "$NO_RUN_REASON" \
    --subject-file "$TEXT_DIR/subject.json" \
    --attempt-key "$TEXT_DIR" || exit $?
fi
```

Settle refuses, writing nothing, while the run is still live (collect it
first), for a run of another workflow or phase, and with `DISPATCH_DIR` empty
while a run of this phase is pending (settle that run by its id). Once it has
recorded the attempt, running it again records nothing more.
<!-- pipeline:end refine-review-settle -->

---

## Completion — Active Next-Action Proposal

At the end of a successful refine (both paths), emit an **Active Next-Action
Proposal** instead of a fixed next verb — derived from this refinement, not a
fixed table:

```
- selected_next:         <verb | commit | done | owner decision>
- rejected_alternatives: <1-2 alternatives, each + one-line why-not>
- rationale:             <why best — the design reconciles + the accessibility gate verdict; the decisive design axes (사용성 Usability + the archetype axis) for a fork>
- evidence_pointers:     <revised elements / criteria refs / artifact path — pointers only>
- confidence:            <HIGH | MEDIUM | LOW>
- next_command:          <exact next step: /designer:<verb> … or $designer:<verb> for a verb; the owner's save and commit for commit; none for done; the owner's decision otherwise>
```

Typical `selected_next` candidates for refine: `/designer:critique` to re-critique
the revised artifact (the convergence handoff — confirm the finding is resolved
and no new barrier opened) — or "the design is sound, proceed" when the change was
small and reconciles cleanly, or `/designer:investigate` when the refinement
exposed a load-bearing pattern/accessibility assumption that needs evidence. The
routing is a fallback only when evidence is genuinely neutral — do not end with a
hardcoded "next: X". A blocked outcome (peer flagged a regression / a new
accessibility barrier) pauses for user direction before any forward proposal.

**A finding that recurs** — one an earlier refine pass on this workflow
already addressed survives verification again — is the owner's call:
`/designer:refine` ends with the `recurring-finding` owner gate instead of a
terminal write, and its Owner decision step records fix-now-or-defer and
clears the gate (`../_shared/references/entry-routing-contract.md` § Owner
gates).

**Surface note (ADR-0042 Accepted).** The full designer surface ships: the
six cognitive verbs (`investigate` / `frame` / `decide` / `compose` /
`critique` / `refine`), the `/designer:start` lifecycle macro, and the
`resume` / `checkpoint` / `peer-now` meta skills. Every `next_command` this
proposal can name is runnable. The refinement summary is the durable handoff.

Always include the workflow path when invoked from a workflow command:

```
Workflow: <absolute path to workflow .md file>
```

<!-- pipeline:begin refine-finish-convergent -->
This verb closes only once it converged (`terminal_requires_convergence`).
Not converged, it leaves the workflow open and prints no footer: unless an
owner gate ends it, the finalize's last write is an `append` that records the
next step resolving the flagged item (`refine`, `decide` or `investigate`) and
turns off a terminal marker an earlier verb left, so the Stop hook cannot
archive it; an owner's deferral of a recurring finding is cleared with that
next step (`awaiting-owner-clear`), and no terminal write is made. Converged,
it ends as follows.

Run by `/designer:refine`, the command's last write, `state.mjs
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
`$designer:refine` on Codex surfaces the footer as
`/designer:refine` does. Wiring:
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
<!-- pipeline:end refine-finish-convergent -->

---

## Multi-axis lens at a 2+-branch point (ADR-0029 §2)

If a refinement reaches a **genuine 2+-branch decision point** — two viable
remediation directions, or two ways to close the same gap — surface a **compact
multi-axis lens** across the decisive design axes (사용성 Usability + the archetype
axis) + the accessibility gate, reading `../decide/references/decision-axes.yml`
(the `scripts/decide-registry.mjs resolve` resolver, with the active profile in
`AGENTIC_DESIGNER_PROFILE` and no `--size`, gives the profile's preset:
`../_shared/references/entry-routing-contract.md` § Surfacing the multi-axis
lens from a non-decide verb; the registry file is readable even when the resolver CLI
is not). Bounded: only at a genuine 2+-branch point, never the full matrix for a
trivial reversible fix. A weightier fork routes to `/designer:decide` rather than
being settled inside the refine.

---

## Anti-patterns (do not produce)

- **Refining before the *why* is confirmed**. Apply the upstream contract:
  critique / investigate → decide (if needed) → refine. A fix without a confirmed
  finding papers over the symptom.
- **Choosing silently between remediation directions** when 2+ viable approaches
  exist. Route through `/designer:decide`.
- **Marking refinement complete on an unreconciled artifact or an unresolved
  re-critique**. If the revised flow no longer satisfies its states, or a
  re-critique surfaces a new CRITICAL / MAJOR, the refinement is not done — the
  convergence loop has not closed.
- **Clearing a usability/conversion problem by introducing an accessibility
  barrier**. That moves the veto gate, it does not clear it — surface the new
  candidate WCAG A/AA exposure, never bury it. An unmitigated barrier introduced
  by the revision is CRITICAL.
- **Upgrading an assumption to a fact**. A revision must not silently drop a
  `[to be validated]` marker to make the design look more certain.
- **Sending screenshots to the peer as bytes**. The Refine-verify peer path is
  code/text or a verified-local absolute path; `codex-companion` has no `--image`
  flag. Vision-grounded re-critique is same-host.
- **Leaking proprietary material** to the peer or to web search. Genericize the
  revision; screenshots are sensitive by default and never sent as bytes.
- **Certifying accessibility conformance** on the re-critique. The gate flags
  *candidate* WCAG A/AA issues; conformance needs runtime testing (focus order,
  keyboard, screen-reader) per ADR-0042 Non-Goal 6. Always state what remains
  unverified.
- **Claiming convergence on a code/text-only pass** when the post-code re-render
  could not be re-critiqued. An unavailable / broken re-render leaves the visual
  re-critique UNVERIFIED — report it, do not mark the refinement complete.
- **Looping indefinitely**. Bound the convergence loop (default 2 passes, hard cap
  3); persistent non-convergence pauses and routes to `/designer:decide` /
  `/designer:investigate` / an owner decision, it does not spin.
