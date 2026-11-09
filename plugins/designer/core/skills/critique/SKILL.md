---
name: critique
description: "Evaluates an existing design artifact — a pre-code design spec OR a post-code rendered screen + frontend code — across the design quality lenses (usability / accessibility / conversion / consistency), with accessibility as a veto gate, and reports severity-rated findings. The designer persona's critique verb (ADR-0010 §2, ADR-0042 SD4). Use for design review, UI/UX review, heuristic evaluation, a candidate accessibility spot-check, a conversion review, or a design-system consistency review — on a spec before code, or on the rendered screen after. Trigger phrases include 'review this screen', 'critique this UI', 'design review', 'is this accessible', 'a11y check', 'heuristic evaluation', 'does this match the design system', 'review the wireframe', 'check this flow', 'poke holes in this design', '디자인 리뷰', '이 화면 봐줘', 'UI 검토', '접근성 체크', '휴리스틱 평가', '디자인 시스템 일관성', '이 화면 괜찮아', '전환율 관점에서 봐줘'."
---

# Critique (designer persona)

The designer plugin's critique verb (per ADR-0010 §2, ADR-0042 SD4). Critique
evaluates an **existing** design artifact against the internalized quality
criteria and reports severity-rated findings. The user is the decision-maker;
this verb is the quality-evaluation engine — it maximizes the rigor and honesty
of the review, not the automation of the fix.

This is designer's **post-code quality-assurance** differentiator (ADR-0042
SD4). Critique operates on two input shapes — the **pre-code** design spec (from
`/designer:compose`) and the **post-code** rendered screen (a screenshot) plus
the frontend code that produced it — and holds both to the same standard: the
single internalized reference in `references/quality-criteria.md`. Fixes are the
`/designer:refine` verb's job; a genuine 2+-direction fork
routes to `/designer:decide`.

## The four quality lenses (ADR-0042 SD4)

The lenses reuse the SD3 decision-axis vocabulary — **a lens name IS an axis id**
(`../decide/references/decision-axes.yml`), so `decide` and `critique` share ONE
vocabulary with no orphan lens. decide uses the axes as decisive/supporting
*roles*; critique uses the same axes as evaluation *lenses*. Each lens applies
the criteria recorded in `references/quality-criteria.md`.

<!-- @critique:lens-table:begin -->
| # | Lens (`--profile=`) | SD3 axis | Gate? | Evaluates against (`references/quality-criteria.md`) |
|---|---------------------|----------|-------|------------------------------------------------------|
| 1 | `usability`    | 사용성 usability     | —        | Nielsen's 10 usability heuristics — § Usability |
| 2 | `a11y`         | 접근성 accessibility | **GATE** | WCAG 2.1/2.2 A/AA candidate checks — § Accessibility |
| 3 | `conversion`   | 전환 conversion      | —        | CTA clarity / value legibility / funnel friction / honest persuasion — § Conversion |
| 4 | `consistency`  | 일관성 consistency   | —        | Design-system + platform + internal-pattern conformance — § Consistency |
<!-- @critique:lens-table:end -->

The **`a11y` lens flag is an alias for the `accessibility` axis** — there is no
`a11y` axis id (mirrors the decide profile-flag alias). The remaining three SD3
axes — **desirability**, **content-clarity**, **feasibility** — are named as
lenses but **defined-but-inactive in v1** (they complete the 1:1 axis
coverage and activate incrementally; see `references/quality-criteria.md`
§ Defined-but-inactive lenses).

> **accessibility HONESTY BOUNDARY (ADR-0042 Non-Goal 6).** The accessibility
> lens flags **candidate** WCAG A/AA issues from specs, code, and screenshots —
> contrast, semantic structure, alt text, visible focus, target size, use of
> color. It does **not** certify conformance: focus **order**, keyboard
> traversal, and screen-reader behavior require runtime interaction testing a
> static critique cannot perform. A gate FAIL is a candidate blocker to resolve
> or explicitly accept-with-rationale, not a conformance certificate. designer
> flags and prioritizes; it does not issue a certificate.

> **Dogfood-validated, still evolving (ADR-0042 SD4).** The active/inactive lens
> split and the criteria weighting were exercised end-to-end by the ADR-0042
> Accepted-flip dogfood — the four active lenses produced real findings and the
> accessibility gate moved a design from FAIL to CONDITIONAL. They remain open to
> re-tuning as dogfood accumulates; the accessibility veto gate is settled.

**Profile selection**: `--profile=<lens>` focuses the review on one lens; a
missing profile runs **all four active lenses** (the default full-surface
critique). An unknown profile, or one of the three defined-but-inactive lenses
(`desirability` / `content-clarity` / `feasibility`), falls back to the full
active set with a one-line warning rather than emitting a half-specified rubric.

**Core principle**: a critique names findings and their severity; it does not
silently rewrite the design. The accessibility gate is a **veto**, not a
tradeoff. A finding that opens two viable remediation directions is a
`/designer:decide` fork, not a critique verdict; applying the fixes is
`/designer:refine`.

**Gate severity rule**: an **unmitigated accessibility veto gate is a CRITICAL
finding by definition** — never demoted to a MINOR or folded into "polish
later". A CONDITIONAL gate is allowed only with the remediation named explicitly.
(The `gate: true` axis is `accessibility` in `../decide/references/decision-axes.yml`.)

---

## Dual input — pre-code spec AND post-code rendered screen (ADR-0042 SD4)

Critique accepts two artifact shapes; it may receive one or both:

1. **Pre-code design spec** — an IA / user-flow / wireframe / component spec /
   CTA copy (typically a `/designer:compose` artifact). Text-only; no vision
   needed. Critique checks each element against the criteria and the
   accessibility acceptance criteria that compose annotated in.
2. **Post-code rendered screen** — a **screenshot** of the built UI plus the
   **frontend code** that produced it. This is where vision applies.

**Vision is host-direct (ADR-0042 SD4 item 3).** On the **active host**, the
model reads the screenshot directly — Claude natively; Codex CLI via
`codex exec --image <file>` — so a screenshot critique run **on the active host
is cross-host symmetric**. Vision-grounded critique of a rendered screen is a
**same-host** capability. `Screenshots are sensitive by default` (see § Privacy
gate).

**The peer path is not host-direct.** `codex-companion.mjs` exposes no `--image`
flag, so **cross-host peer critique is code/text-based**: by default the peer
receives the genericized spec / frontend code and **does not receive the
screenshot at all**, so the authoritative vision-grounded judgment stays
same-host. The one ADR-named exception (the `plugins/image` critique-dispatch
precedent) passes a screenshot as a **verified-local absolute file path
prompt-mediated** — never inline image bytes — and only helps when the peer
shares this host's filesystem (same machine): the path is verified local first
(resolve the real path, confirm it is a regular image file on this host) and
embedded as untrusted text, so the peer may read the file on its own host.
**Either way no image bytes cross the companion bridge, and the vision-grounded
judgment is same-host.** designer's critique ensemble uses the code/text peer
path by default and treats the verified-local-path variant as an explicit
same-filesystem opt-in.

---

## When auto-activated (without command)

Lightweight in-context critique — no peer ensemble dispatch, no subagents.

### Step 1: Identify what to review

Determine the artifact shape (pre-code spec, post-code screen, or both) and the
surface + platform (web / iOS / Android / desktop; viewport; LTR/RTL). If a
screenshot is provided, note that vision applies (same-host). If only a
file/PR reference is given, read the frontend code.

### Step 2: Determine review lenses

Default: run all four active lenses (usability / accessibility / conversion /
consistency). If `--profile=<lens>` (prose equivalent) narrows the intent,
focus there — but the **accessibility gate is always evaluated** even under a
narrowed profile, because an unmitigated barrier is a veto regardless of the
requested focus.

### Step 3: Apply the criteria

For each active lens, evaluate the artifact against the matching section of
`references/quality-criteria.md` (§ Usability / § Accessibility / § Conversion /
§ Consistency). When a screenshot is present, read it directly (same-host
vision) and ground visual findings in what is observed, not guessed from the
filename. Separate observed facts from inference; label aesthetic claims with
the heuristic / criterion they rest on.

### Step 4: Synthesize

Follow the Presentation Mode Protocol
(`../_shared/references/presentation-protocol.md`) before presenting.

Merge findings, dedupe, and sort by severity **CRITICAL > MAJOR > MINOR >
SUGGESTION**. Compute the accessibility **gate verdict** (PASS / CONDITIONAL /
FAIL — candidate-level). An unmitigated gate FAIL is CRITICAL.

### Output format

```
## Review Summary
[1-2 sentences: overall read + the gate verdict headline]

## Gate verdict
접근성 Accessibility: [PASS / CONDITIONAL / FAIL] — [candidate barrier(s); "unverified: focus order / keyboard / screen-reader (runtime)"]

## Critical Issues
- [element / spec section / screen region] [lens] — [finding + the failure signal + criteria ref]

## Major Issues
- ...

## Minor Issues
- ...

## Suggestions
- ...

## Looks Strong
- [what holds up well, per lens]
```

Each finding line is `[element/region] [lens] — [description + failure signal]`.
Gate findings render a candidate PASS/CONDITIONAL/FAIL, never a conformance
certificate.

---

## When invoked by command (`/designer:critique` Claude command or `$designer:critique` Codex skill mention)

Full critique with Design Task Profile + peer ensemble + state-write integration.

### Step 1: Design Task Profile

Build the Design Task Profile per `../investigate/SKILL.md` § Design Task Profile
(Persona=designer; Surface / Users / Stage / Platform / Evidence-confidence
fields; Ensemble Affinity recorded but not gating — always-max policy). The
shared `../_shared/references/orchestration.md` Dynamic Orchestration reference
is the canonical source.

### Step 2: Collect the artifact context

Gather the artifact under review: the pre-code spec text and/or the post-code
screenshot + frontend code. For a screenshot, confirm it is a **local file on
this host** before any external step. Read the relevant frontend source (the
code that renders the screen) so accessibility / consistency findings are
grounded in markup, not only pixels.

### Step 3: Privacy gate (before any external call)

<!-- pipeline:begin critique-privacy-gate -->
PRIVACY GATE: proprietary UI, unreleased features/flows, customer data visible in screenshots, and secret-bearing frontend code
pass an explicit privacy gate before BOTH web search AND peer-host dispatch.
Genericize the artifact before the peer prompt; the pre-genericization value MUST never leave the local host.
See `../investigate/references/design-brief-spec.md` § Privacy Gate.
<!-- pipeline:end critique-privacy-gate -->

<!-- pipeline:begin critique-privacy-no-image -->
No dispatch passes `--image`: the companion peer path has no image channel, so
an image never reaches the peer as bytes.
<!-- pipeline:end critique-privacy-no-image -->

**Screenshots are sensitive by default** — a rendered screen is critiqued
same-host (Claude natively; Codex via `codex exec --image`) and is **never sent
to the peer as inline image bytes**; the peer path is code/text-based, or a
verified-local absolute file path the peer reads on its own host. When
confidentiality is unclear, ask the user, or run **local-only** (skip the peer
and any web reference lookup).

### Step 4: Peer ensemble parallel analysis (Review point type)

Launch the peer ensemble (always-max policy; never ask the user, never direct
them to run companion CLIs manually). The peer receives the **genericized**
artifact — spec text and/or frontend code, or a verified-local screenshot path,
**never image bytes** — and returns an independent code/text critique across the
lenses. Build the Review prompt, write it with the file-writing tool into a private directory (`mktemp -d "${TMPDIR:-/tmp}/agentic-text.XXXXXX"`) as `prompt.xml`, never through the shell (ADR-0059, amendment of 2026-10-10), and dispatch it with
`--prompt-file` in the background. The prompt template + synthesis contract land in
`../_shared/references/ensemble-protocol.md` § Review; the dispatch shape
mirrors the reference-scan dispatch in
`../investigate/references/design-brief-ensemble.md` (command-managed via
`scripts/peer-runner.mjs`). See `commands/critique.md` for the concrete dispatch
bash.

The peer's core contribution is the code/text perspective (semantic structure,
naming, pattern/token conformance, copy, funnel logic). By default it receives no
screenshot, so the vision-grounded findings (contrast as-rendered, visual
hierarchy, spacing) are the same-host model's responsibility; no inline image
bytes ever reach the peer.

### Step 5: Synthesize

Reconcile local + peer findings per AGREED / LOCAL-ONLY / PEER-ONLY / CONFLICT.
Label discovery side (`[Local]` / `[Peer]` / `[Both]`) in workflow phase notes
only — never in a saved artifact. Dedupe, then sort by severity. An unmitigated
accessibility gate FAIL is CRITICAL regardless of which side found it. Present
CONFLICT findings both ways and let the user weigh them. A synthesis verdict
of `conflict` ends `/designer:critique` with the `peer-conflict` owner gate,
with a bounded consensus round proposed first (ADR-0067 Decision 8).

### Step 6: Present

Follow the Presentation Mode Protocol
(`../_shared/references/presentation-protocol.md`) before presenting.

Emit the severity-grouped report (the Output format above), leading with the
gate verdict. State plainly what remains **unverified** (focus order, keyboard,
screen-reader — runtime).

### State write (when invoked from a workflow command)

When `/designer:critique` runs as a sub-step of a designer workflow command (the
`/designer:start` lifecycle macro), the invoking command writes the
critique findings + gate verdict to its workflow file. This skill itself does
not write workflow state. When invoked standalone, no workflow file write occurs.

<!-- pipeline:begin critique-review-settle -->
**On Codex, the skill settles its review (C163 A1a).** Besides the
workflow writes the state-write note above names, on Codex this skill also
settles its review in the workflow. A review leaves one outcome per attempt in the
workflow (ADR-0023, implementation note of 2026-11-05), and it is the settle
that records it. On Claude,
`/designer:critique`'s finalize settles the attempt, and inside
`/designer:start` or `$designer:start` the lifecycle settles each phase:
skip this step there. On Codex, `$designer:critique` has no command file to
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

At the end of a successful critique (both paths), emit an **Active Next-Action
Proposal** instead of a fixed next verb — derived from the findings, not a fixed
table:

```
- selected_next:         <verb | commit | done | owner decision>
- rejected_alternatives: <1-2 alternatives, each + one-line why-not>
- rationale:             <why best — the decisive findings + the accessibility gate verdict>
- evidence_pointers:     <finding sections / criteria refs / artifact path — pointers only>
- confidence:            <HIGH | MEDIUM | LOW>
- next_command:          <exact next step: /designer:<verb> … or $designer:<verb> for a verb; the owner's save and commit for commit; none for done; the owner's decision otherwise>
```

Typical `selected_next` candidates for critique: `/designer:refine` to address
the selected findings (CRITICAL + MAJOR by default; the user picks which MINOR /
SUGGESTION items to include) — or `/designer:decide` when a finding opens a
genuine 2+-direction fork, or `/designer:investigate` when a load-bearing
accessibility or convention claim needs authoritative evidence. When no CRITICAL
or MAJOR (and the gate is not FAIL — `PASS`, or `CONDITIONAL` with its
remediations named), the design is in good shape — say so. The routing
is a fallback only when evidence is genuinely neutral — do not end with a
hardcoded "next: X".

**Surface note (ADR-0042 Accepted).** The full designer surface ships: the
six cognitive verbs (`investigate` / `frame` / `decide` / `compose` /
`critique` / `refine`), the `/designer:start` lifecycle macro, and the
`resume` / `checkpoint` / `peer-now` meta skills. Every `next_command` this
proposal can name is runnable. The critique report is the durable handoff.

Always include the workflow path when invoked from a workflow command:

```
Workflow: <absolute path to workflow .md file>
```

<!-- pipeline:begin critique-finish -->
Run by `/designer:critique`, the command's last write, `state.mjs
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
`$designer:critique` on Codex surfaces the footer as
`/designer:critique` does. Wiring:
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

If a critique surfaces a **genuine 2+-branch decision point** — two viable
remediation directions, or two defensible severity reads of the same finding —
surface a **compact multi-axis lens** across the decisive design axes (사용성
Usability + the archetype axis) + the accessibility gate, reading
`../decide/references/decision-axes.yml` (the `scripts/decide-registry.mjs
resolve` resolver, with the active profile in `AGENTIC_DESIGNER_PROFILE` and no
`--size`, gives the profile's preset:
`../_shared/references/entry-routing-contract.md` § Surfacing the multi-axis
lens from a non-decide verb). Bounded: only at a genuine 2+-branch point, never the
full matrix for a trivial reversible fix. A weightier fork routes to
`/designer:decide` rather than being settled inside the critique.

---

## Anti-patterns (do not produce)

- **Certifying accessibility conformance**. The gate flags *candidate* WCAG A/AA
  issues; it does not issue a certificate — focus order, keyboard traversal, and
  screen-reader behavior need runtime testing (ADR-0042 Non-Goal 6). Always state
  what remains unverified.
- **Demoting an unmitigated accessibility barrier**. A hard candidate WCAG A/AA
  barrier is CRITICAL and a veto — never a MINOR, never "polish later".
- **Guessing from the filename**. A screenshot critique reads the image
  (same-host vision); it does not infer the UI from the file name or the code
  alone when the pixels are available.
- **Sending screenshots to the peer as bytes**. The peer path is code/text or a
  verified-local absolute path; `codex-companion` has no `--image` flag. Vision
  is same-host.
- **Leaking proprietary material** to the peer or to web search. Genericize the
  artifact; screenshots are sensitive by default and never sent as bytes.
- **Fixing inside the critique**. Critique names findings and severity; applying
  them is `/designer:refine`. A 2+-direction remediation fork is `/designer:decide`.
- **Aesthetic claims without grounding** ("looks cleaner", "more modern") — every
  finding rests on a heuristic, WCAG criterion, conversion principle, or
  consistency rule in `references/quality-criteria.md`.
