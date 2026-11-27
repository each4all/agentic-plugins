---
name: refine
description: "Applies critique findings or feedback to a business artifact — revises the venture plan, brief, or canvas, then verifies the change holds together. The founder persona's refinement verb (per ADR-0010 §2, ADR-0036 SD6). Use after a critique to incorporate the findings, or to apply feedback to a plan. Trigger phrases include 'apply the findings', 'address the review', 'revise the plan', 'incorporate the feedback', 'fix the unit-economics', 'tighten the strategy', 'update the canvas', 'apply the critique', '리뷰 반영', '피드백 반영', '계획 수정', '플랜 고쳐줘', '지적 반영', '보완해줘'."
---

# Refine (founder persona)

The founder plugin's refinement verb (per ADR-0010 §2, ADR-0036 SD6).
Apply critique findings or feedback to an existing **business artifact**
(a venture plan, a brief, a lean / business-model canvas, a strategy) and
verify the revision holds together. Refine assumes the *what to change*
is known; the work is doing it faithfully and confirming the artifact
stays internally consistent.

This verb takes no `--profile` argument — refine is single-mode by design
(the verb's purpose is faithful application + verification of an
already-decided change). Business sub-discipline context flows through
the Business Task Profile per `../_shared/references/orchestration.md`,
not via per-call profile arguments.

**Core principle**: do not revise the plan until the *why* is confirmed.
When refining in response to a business critique or an underperformance,
the upstream contract is:

```
critique (or investigate --profile=root-cause for an underperformance)
   →  decide (if 2+ viable remediation directions)
   →  refine
```

Skipping critique/investigate produces revisions that paper over the
symptom (a margin "fixed" by an unsupported assumption). Skipping decide
when 2+ remediation directions exist locks in an undeliberated change.

**Verify means internal consistency, not "run tests".** A business
artifact has no test suite — the verification is that the revised
sections still reconcile: do the revised unit-economics still hold up
against the go-to-market and pricing? Did the change open a new
regulatory / safety gate exposure? Are still-unverified numbers still
marked `[to be validated]`? founder does not let a revision quietly
introduce a fresh inconsistency.

---

## When auto-activated (without command)

Lightweight in-context refinement — no peer ensemble dispatch.

### Step 1: Verify upstream

Before revising, confirm the basis for the change:

- For critique-driven changes: a finding list from `/founder:critique`
  (or an equivalent feedback document).
- For underperformance-driven changes: a confirmed root cause from
  `/founder:investigate --profile=root-cause`. If none is confirmed,
  suggest running investigate first.
- For direction-driven changes: the direction is confirmed via
  `/founder:decide` (when 2+ viable remediation directions existed).

If multiple findings are pending, present them as a list and confirm with
the user which to address now (all? a subset? defer the rest?).

### Step 2: Apply the revision

For each item being addressed:

1. State the change before applying it: "Plan: revise the `<section>` to
   <action> because <finding>."
2. Apply the change to the artifact.
3. If the change is non-trivial (it touches unit-economics, the
   business model, or a gate-relevant section), present the before→after
   and confirm before moving on.

When the remediation involves 2+ viable directions, do NOT choose
silently — route through `/founder:decide` first.

### Step 3: Verify internal consistency

1. Re-read the sections downstream of the change. Confirm they still
   reconcile (a revised price flows to revised unit-economics flows to a
   revised go-to-market and milestone set).
2. Confirm the change did not introduce a new veto-gate exposure (규제노출
   Regulatory-Exposure, 안전리스크 Safety/Harm-Risk). A revision that solves
   a market problem by entering a regulated activity has moved the gate,
   not cleared it.
3. Confirm every still-unverified number or claim still carries its
   `[to be validated]` marker — a revision must not silently upgrade an
   assumption to a fact.

If verification surfaces a new inconsistency, return to Step 2 and report
it. Do NOT mark the refinement complete on an unreconciled artifact.

### Step 4: Present the result

Follow the Presentation Mode Protocol
(`../_shared/references/presentation-protocol.md`) before presenting.

```
## Refinement Summary
- Applied: [N findings / 1 revision / etc.]
- Verified: [downstream sections reconcile; gate exposure unchanged;
  [to be validated] markers intact]
- Deferred: [items not addressed and why]
```

If findings remain, that informs the Active Next-Action Proposal at
completion — typically `/founder:critique` again on the revised artifact
to confirm the change did not expose a new weakness.

---

## When invoked by command (`/founder:refine` Claude command or `$founder:refine` Codex skill mention)

Full refinement with Business Task Profile + peer ensemble verification +
state-write.

### Step 1: Business Task Profile

Build the Business Task Profile per
`../_shared/references/orchestration.md` Step 1 (Market / Segment / Stage
/ Risk-class / Evidence-confidence).

### Step 2: Apply the revision

Follow Step 2 above, at command fidelity.

### Step 3: Privacy gate (before any external call)

<!-- pipeline:begin refine-privacy-gate -->
PRIVACY GATE: proprietary venture concepts, interview/customer data, and unpublished business material
pass an explicit privacy gate before BOTH web search AND peer-host dispatch.
Genericize the revision before the peer prompt; the pre-genericization value MUST never leave the local host.
See `../investigate/references/business-brief-spec.md` § Privacy Gate.
<!-- pipeline:end refine-privacy-gate -->

<!-- pipeline:begin refine-privacy-no-image -->
No dispatch passes `--image`: the companion peer path has no image channel, so
an image never reaches the peer as bytes.
<!-- pipeline:end refine-privacy-no-image -->

### Step 4: Peer ensemble parallel verification (Refine-verify point)

Launch the peer ensemble per `../_shared/references/ensemble-protocol.md`
using the **Refine-verify** ensemble point type (peer `task` with the
Refine-verify prompt template per
`../_shared/references/ensemble-protocol.md` §Refine-verify). The peer
independently verifies the revision resolves the finding without
introducing a new inconsistency or a new gate exposure.

The peer call is automatic (always-max policy); skills do not pass
`--model` / `--effort`.

### Step 5: Synthesize

Follow the Presentation Mode Protocol
(`../_shared/references/presentation-protocol.md`) before presenting.

After both sides return:

1. Re-check internal consistency (Step 3 of auto-activated mode).
2. Collect the peer verification.
3. Synthesize per `../_shared/references/ensemble-protocol.md` §Base
   Synthesis Categories.
4. Resolve any new findings:
   - Straightforward → apply inline (return to Step 2).
   - 2+ viable directions → route through `/founder:decide`.
   - A peer-flagged regression (new inconsistency / new gate exposure) →
     pause and report to the user before proceeding.

Loop Steps 2-5 until no new findings emerge.

<!-- pipeline:begin refine-pass-settle -->
**Each pass settles its own run (C163 A1a).** Every refine-verify a pass
runs, or would have run, is a review attempt of its own, and the workflow
keeps one outcome per attempt (ADR-0023, implementation note of 2026-11-05).
The finalize settles the last pass's attempt only: on Claude
`/founder:refine`'s Phase 2, inside a `/founder:start` or
`$founder:start` lifecycle its refine phase, and on Codex this skill's
settle step below. So when the loop goes back to Step 2, settle the pass just
done first, once its synthesis is done, with the block below, whether it
launched a run or not; leave the last pass, launched or not, to the finalize.
Left unsettled, an earlier pass's launched run stays an open attempt that
reads `unknown`, its pending row stays, and settle refuses every later settle
of phase refine that names no run; an earlier pass that launched no run (the
peer not found, the privacy gate, a local-only pass) leaves no attempt at
all. With no active founder workflow on this branch there is nothing to
settle, and the block says so.

Make a new private directory for the pass, and note the path it prints:

```bash
# A private text directory, marked so that the step that reads it
# last releases it (ADR-0059 Decisions 9 and 10).
MAKE_KIND='text'
MAKE_PARENT=''
# ADR-0059 Decision 9: make and mark the directory MAKE_KIND names (text or
# op; MAKE_PARENT, when set, for an op nested in it); its path is MADE_DIR.
# The fallbacks of Decision 10, item 4 make it the old way: an older
# state.mjs, lacking tmpdir-make, and a platform where the make is unsupported
# with mktemp -d, a nested op in a parent made the old way with mkdir. A fallback's path is
# checked for what a single-quoted shell literal cannot carry, as the make
# checks its own. Each status is read in a condition, so errexit changes
# nothing here.
MADE_DIR=''
if grep -q -e "'tmpdir-make'" "<plugin-root>/scripts/state.mjs" 2>/dev/null; then
  if [ -n "${MAKE_PARENT:-}" ]; then
    MADE_DIR="$(node "<plugin-root>/scripts/state.mjs" tmpdir-make --kind op --parent "$MAKE_PARENT")" && MAKE_RC=0 || MAKE_RC=$?
  else
    MADE_DIR="$(node "<plugin-root>/scripts/state.mjs" tmpdir-make --kind "$MAKE_KIND")" && MAKE_RC=0 || MAKE_RC=$?
  fi
elif [ -r "<plugin-root>/scripts/state.mjs" ]; then
  MAKE_RC=old
else
  echo "✗ Cannot read <plugin-root>/scripts/state.mjs; no directory was made." >&2
  exit 1
fi
case "$MAKE_RC" in
  0) ;;
  3|4|old)
    if [ -n "${MAKE_PARENT:-}" ]; then
      MADE_DIR="$MAKE_PARENT/op"
      mkdir -m 700 "$MADE_DIR" || { echo "✗ $MADE_DIR already holds an operation directory, or cannot be made: run from a fresh directory. No directory was made." >&2; exit 1; }
    else
      MADE_DIR="$(mktemp -d "${TMPDIR:-/tmp}/agentic-$MAKE_KIND.XXXXXX")" || exit 1
      [ "$MAKE_RC" != 3 ] || echo "agentic-dir make: unsupported on this platform; $MADE_DIR was made with mktemp -d and will not be released" >&2
    fi
    node -e 'process.exit(/[\x00-\x1f\x7f\x27]/.test(process.argv[1])?1:0)' "$MADE_DIR" \
      || { echo "✗ The directory made holds a quote or a control character, which a single-quoted shell literal cannot carry; set TMPDIR to a path without one." >&2; exit 1; }
    ;;
  5) echo "✗ TMPDIR (${TMPDIR:-/tmp}) holds a quote or a control character, which a single-quoted shell literal cannot carry; set TMPDIR to a path without one. No directory was made." >&2; exit 1 ;;
  *) exit 1 ;;
esac
[ -n "$MADE_DIR" ] || { echo "✗ The make printed no directory; nothing can be written." >&2; exit 1; }
printf '%s\n' "$MADE_DIR"
```

Write the pass's one-line synthesis résumé there as `summary.txt` with your
file-writing tool, not the shell (ADR-0059, amendment of 2026-10-10): that
directory is `TEXT_DIR`, a new one for each pass. Once the pass is settled,
the block releases it and the pass's dispatch directory, a run launched or
not (ADR-0059 Decision 10); a block that stops keeps both for its rerun. Set `HOST` to the host you
run on, `claude` or `codex`, and fill `<plugin-root>` with this plugin's
installed root, the path you read this SKILL.md from, cut before its
`/core/skills/` directory. Then:

- whenever the pass made a dispatch directory, a run launched or not:
  `DISPATCH_TEXT_DIR` set to it, so that the block releases it once the pass
  is settled (a dispatch that stopped before any run, its `prompt.xml.err`
  saying why, leaves one too); empty when none was made.
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
# The pass's dispatch directory, a run launched or not; empty when none was made.
DISPATCH_TEXT_DIR='<the directory this pass dispatch ran with, a run launched or not; empty when none was made>'
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
# A placeholder left as written opens with "<"; a directory the make printed
# is an absolute path, which never does, whatever it holds further on.
case "$TEXT_DIR" in
  ''|'<'*) echo "✗ TEXT_DIR is empty or not filled in; nothing was settled." >&2; exit 1 ;;
esac
case "$DISPATCH_DIR" in
  '<'*) echo "✗ DISPATCH_DIR is not filled in (empty when the pass launched no run); nothing was settled." >&2; exit 1 ;;
esac
case "$DISPATCH_TEXT_DIR" in
  '<'*) echo "✗ DISPATCH_TEXT_DIR is not filled in (empty when the pass made no dispatch directory); nothing was settled." >&2; exit 1 ;;
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
if [ -z "$ACTIVE" ]; then
  echo "No active workflow on this branch: no review attempt to settle." >&2
elif [ -n "$DISPATCH_DIR" ]; then
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
# ADR-0059 Decision 10, item 1 — the attempt is settled (or there was no
# workflow to settle it in): no block, rerun or continuation reads the summary
# or the dispatch's result again. The pass's dispatch directory is released
# from DISPATCH_TEXT_DIR, a run launched or not (an already released path is
# absent, and the release says nothing).
for RELEASE_PATH in "$TEXT_DIR" "$DISPATCH_DIR" "$DISPATCH_TEXT_DIR"; do
  # ADR-0059 Decision 10, item 4: release RELEASE_PATH (nothing when it is
  # empty), cleanup only. On standard error the CLI's own line, or one of these
  # when its result cannot be read; the block's standard output and exit status
  # stay what its own work set, errexit or not.
  if [ -n "${RELEASE_PATH:-}" ]; then
    if grep -q -e "'tmpdir-release'" "<plugin-root>/scripts/state.mjs" 2>/dev/null; then
      RELEASE_REPORT="$(node "<plugin-root>/scripts/state.mjs" tmpdir-release --path "$RELEASE_PATH")" || :
      node -e 'let r=null;try{r=JSON.parse(process.argv[1])}catch{}process.exit(r!==null&&typeof r==="object"&&typeof r.outcome==="string"?0:1)' "$RELEASE_REPORT" 2>/dev/null \
        || echo "agentic-dir release: the result is unknown; the directory may remain at $RELEASE_PATH or at its .removing- path" >&2
    elif [ -r "<plugin-root>/scripts/state.mjs" ]; then
      echo "agentic-dir release: no tmpdir-release in this state.mjs; the directory is kept at $RELEASE_PATH" >&2
    else
      echo "agentic-dir release: the result is unknown (cannot read <plugin-root>/scripts/state.mjs); the directory may remain at $RELEASE_PATH" >&2
    fi
  fi
done
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

When `/founder:refine` runs as a sub-step of a founder workflow command,
the invoking command writes the applied revision (section, summary) and
the verification result (consistency confirmed, peer verdict) to its
workflow file. This skill itself writes no phase note; its own workflow
writes are the settles of its refine-verify attempts: each earlier pass's,
launched or not (the pass settle above) and, on Codex, the last pass's (the
settle step below). When invoked standalone, no workflow file write occurs.

<!-- pipeline:begin refine-review-settle -->
**On Codex, the skill settles its review (C163 A1a).** Besides the
workflow writes the state-write note above names, on Codex this skill also
settles its review in the workflow. A review leaves one outcome per attempt in the
workflow (ADR-0023, implementation note of 2026-11-05), and it is the settle
that records it. On Claude,
`/founder:refine`'s finalize settles the attempt, and inside
`/founder:start` or `$founder:start` the lifecycle settles each phase:
skip this step there. On Codex, `$founder:refine` has no command file to
run that finalize (ADR-0013), so when `state.mjs find-active` names an active
founder workflow on this branch, this skill settles the attempt itself,
once the synthesis is done and before it reports. Where the skill runs more
than one review in one run (refine's loop), it settles each earlier pass's
attempt, launched or not, as its own step says, and this block settles the
last pass's only. Left unsettled, a launched
review stays an open attempt that reads `unknown`, and one that never launched
leaves no attempt at all. With no active workflow there is nothing to record:
dispatch a manual run, `--kind manual` with no `--workflow-path`, `--phase`,
`--ensemble-type` or `--run-id` (the runner refuses `--kind ensemble`
without a workflow), and once the synthesis has read the run's result run this
step's blocks all the same, `DISPATCH_DIR` empty and `NO_RUN_REASON`
`local-only`: the settle block finds no workflow, records nothing and
releases the directories (ADR-0059 Decision 10).

Dispatch the review as the ensemble protocol's Launch step says, through
`peer-runner.mjs run` with the workflow's accounting flags, all of them:
`--kind ensemble --workflow-path <the active workflow> --phase refine
--ensemble-type <type> --host codex --run-id <id>`, the id printed by
`peer-runner.mjs new-run-id --prefix <type>`, and the type `refine-verify`.
Without `--kind ensemble` the runner records a manual run: no attempt is
registered, and settle refuses the run. Write the prompt as
`prompt.xml` in a private directory of its own, made and marked as step 1
below makes the summary's (ADR-0059 Decision 9), and send the runner's JSON
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
   # Step 1: a private text directory, marked so that the step that reads it
   # last releases it (ADR-0059 Decisions 9 and 10).
   MAKE_KIND='text'
   MAKE_PARENT=''
   # ADR-0059 Decision 9: make and mark the directory MAKE_KIND names (text or
   # op; MAKE_PARENT, when set, for an op nested in it); its path is MADE_DIR.
   # The fallbacks of Decision 10, item 4 make it the old way: an older
   # state.mjs, lacking tmpdir-make, and a platform where the make is unsupported
   # with mktemp -d, a nested op in a parent made the old way with mkdir. A fallback's path is
   # checked for what a single-quoted shell literal cannot carry, as the make
   # checks its own. Each status is read in a condition, so errexit changes
   # nothing here.
   MADE_DIR=''
   if grep -q -e "'tmpdir-make'" "<plugin-root>/scripts/state.mjs" 2>/dev/null; then
     if [ -n "${MAKE_PARENT:-}" ]; then
       MADE_DIR="$(node "<plugin-root>/scripts/state.mjs" tmpdir-make --kind op --parent "$MAKE_PARENT")" && MAKE_RC=0 || MAKE_RC=$?
     else
       MADE_DIR="$(node "<plugin-root>/scripts/state.mjs" tmpdir-make --kind "$MAKE_KIND")" && MAKE_RC=0 || MAKE_RC=$?
     fi
   elif [ -r "<plugin-root>/scripts/state.mjs" ]; then
     MAKE_RC=old
   else
     echo "✗ Cannot read <plugin-root>/scripts/state.mjs; no directory was made." >&2
     exit 1
   fi
   case "$MAKE_RC" in
     0) ;;
     3|4|old)
       if [ -n "${MAKE_PARENT:-}" ]; then
         MADE_DIR="$MAKE_PARENT/op"
         mkdir -m 700 "$MADE_DIR" || { echo "✗ $MADE_DIR already holds an operation directory, or cannot be made: run from a fresh directory. No directory was made." >&2; exit 1; }
       else
         MADE_DIR="$(mktemp -d "${TMPDIR:-/tmp}/agentic-$MAKE_KIND.XXXXXX")" || exit 1
         [ "$MAKE_RC" != 3 ] || echo "agentic-dir make: unsupported on this platform; $MADE_DIR was made with mktemp -d and will not be released" >&2
       fi
       node -e 'process.exit(/[\x00-\x1f\x7f\x27]/.test(process.argv[1])?1:0)' "$MADE_DIR" \
         || { echo "✗ The directory made holds a quote or a control character, which a single-quoted shell literal cannot carry; set TMPDIR to a path without one." >&2; exit 1; }
       ;;
     5) echo "✗ TMPDIR (${TMPDIR:-/tmp}) holds a quote or a control character, which a single-quoted shell literal cannot carry; set TMPDIR to a path without one. No directory was made." >&2; exit 1 ;;
     *) exit 1 ;;
   esac
   [ -n "$MADE_DIR" ] || { echo "✗ The make printed no directory; nothing can be written." >&2; exit 1; }
   printf '%s\n' "$MADE_DIR"
   ```

2. With your file-writing tool, not the shell, create `summary.txt` in that
   directory holding a one-line résumé of the synthesis, ending with one
   newline. Once the attempt is settled, the block releases this directory
   and the dispatch's, a run launched or not (ADR-0059 Decision 10); a block
   that stops keeps both for its rerun.

Then run the block with `TEXT_DIR` set to that directory and `<plugin-root>`
filled with this plugin's installed root, the path you read this SKILL.md
from, cut before its `/core/skills/` directory:

- whenever a dispatch directory was made, a run launched or not:
  `DISPATCH_TEXT_DIR` set to it, so that the block releases it once the
  attempt is settled (a dispatch that stopped before any run, its
  `prompt.xml.err` saying why, leaves one too); empty when none was made.
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
# The dispatch's directory, a run launched or not; empty when none was made.
DISPATCH_TEXT_DIR='<the directory the dispatch ran with, a run launched or not; empty when none was made>'
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
# A placeholder left as written opens with "<"; a directory the make printed
# is an absolute path, which never does, whatever it holds further on.
for FILLED in "$TEXT_DIR" "$DISPATCH_DIR" "$DISPATCH_TEXT_DIR"; do
  case "$FILLED" in
    '<'*) echo "✗ TEXT_DIR, DISPATCH_DIR or DISPATCH_TEXT_DIR is not filled in (DISPATCH_DIR empty when no run launched, DISPATCH_TEXT_DIR when no dispatch directory was made); nothing was settled." >&2; exit 1 ;;
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
if [ -z "$ACTIVE" ]; then
  echo "No active workflow on this branch: no review attempt to settle." >&2
elif [ -n "$DISPATCH_DIR" ]; then
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
# ADR-0059 Decision 10, item 1 — the attempt is settled (or there was no
# workflow to settle it in): no block, rerun or continuation reads the summary
# or the dispatch's result again. The dispatch's directory is released from
# DISPATCH_TEXT_DIR, a run launched or not (an already released path is
# absent, and the release says nothing).
for RELEASE_PATH in "$TEXT_DIR" "$DISPATCH_DIR" "$DISPATCH_TEXT_DIR"; do
  # ADR-0059 Decision 10, item 4: release RELEASE_PATH (nothing when it is
  # empty), cleanup only. On standard error the CLI's own line, or one of these
  # when its result cannot be read; the block's standard output and exit status
  # stay what its own work set, errexit or not.
  if [ -n "${RELEASE_PATH:-}" ]; then
    if grep -q -e "'tmpdir-release'" "<plugin-root>/scripts/state.mjs" 2>/dev/null; then
      RELEASE_REPORT="$(node "<plugin-root>/scripts/state.mjs" tmpdir-release --path "$RELEASE_PATH")" || :
      node -e 'let r=null;try{r=JSON.parse(process.argv[1])}catch{}process.exit(r!==null&&typeof r==="object"&&typeof r.outcome==="string"?0:1)' "$RELEASE_REPORT" 2>/dev/null \
        || echo "agentic-dir release: the result is unknown; the directory may remain at $RELEASE_PATH or at its .removing- path" >&2
    elif [ -r "<plugin-root>/scripts/state.mjs" ]; then
      echo "agentic-dir release: no tmpdir-release in this state.mjs; the directory is kept at $RELEASE_PATH" >&2
    else
      echo "agentic-dir release: the result is unknown (cannot read <plugin-root>/scripts/state.mjs); the directory may remain at $RELEASE_PATH" >&2
    fi
  fi
done
```

Settle refuses, writing nothing, while the run is still live (collect it
first), for a run of another workflow or phase, and with `DISPATCH_DIR` empty
while a run of this phase is pending (settle that run by its id). Once it has
recorded the attempt, running it again records nothing more.
<!-- pipeline:end refine-review-settle -->

---

## Completion — Active Next-Action Proposal

At the end of a successful refine (both paths), emit an **Active
Next-Action Proposal** instead of a fixed next verb — derived from this
refinement, not a fixed table:

```
- selected_next:         <verb | commit | done | owner decision>
- rejected_alternatives: <1-2 alternatives, each + one-line why-not>
- rationale:             <why best — 본질/근본 (essence/foundation) + consistency/gate check>
- evidence_pointers:     <revised sections / artifact path — pointers only>
- confidence:            <HIGH | MEDIUM | LOW>
- next_command:          <exact next step: /founder:<verb> … or $founder:<verb> for a verb; the owner's save and commit for commit; none for done; the owner's decision otherwise>
```

Typical `selected_next` candidates for refine: `/founder:critique` to
confirm the revision with another review pass — or "the plan is sound,
proceed" when the change was small and the artifact reconciles, or
`/founder:investigate` when the refinement exposed a load-bearing
assumption that needs evidence. The routing is a fallback only when
evidence is genuinely neutral — do not end with a hardcoded "next: X". A
blocked outcome (peer flagged a regression) pauses for user direction
before any forward proposal.

**A finding that recurs** — one an earlier refine pass on this workflow
already addressed survives verification again — is the owner's call:
`/founder:refine` ends with the `recurring-finding` owner gate instead of a
terminal write, and its Owner decision step records fix-now-or-defer and
clears the gate (`../_shared/references/entry-routing-contract.md` § Owner
gates).

<!-- pipeline:begin refine-finish -->
Run by `/founder:refine`, the command's last write, `state.mjs
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
`$founder:refine` on Codex surfaces the footer as
`/founder:refine` does. Wiring:
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
<!-- pipeline:end refine-finish -->

---

## Multi-axis lens at a 2+-branch point (ADR-0029 §2)

When refine reaches a **genuine 2+-branch decision point** — two viable
remediation directions, or two ways to close the same gap — surface a
**compact multi-axis lens** comparing the branches across the decisive
business axes (시장성 / 단위경제) + the veto gates, instead of a flat list,
reading `../decide/references/decision-axes.yml` (the
`scripts/decide-registry.mjs resolve --size=minor` compact 4-axis set;
the registry file is readable even when the resolver CLI is not).
Bounded: only at a genuine 2+-branch point, never the full matrix for a
trivial reversible step. A weightier fork should route to
`/founder:decide`.

---

## Anti-patterns (do not produce)

- **Refining before the why is confirmed**. Apply the upstream contract:
  critique / investigate → decide (if needed) → refine.
- **Choosing silently between remediation directions** when 2+ viable
  approaches exist. Route through `/founder:decide`.
- **Marking refinement complete on an unreconciled artifact**. If the
  revised unit-economics no longer reconcile with the go-to-market, the
  refinement is not done.
- **Solving a market problem by quietly entering a regulated activity**.
  That moves the veto gate, it does not clear it — surface the new
  exposure, do not bury it.
- **Upgrading an assumption to a fact**. A revision must not silently drop
  a `[to be validated]` marker to make the plan look more certain.
- **Leaking proprietary material** to the peer or to web search.
  Genericize the revision before any external call.
- **Professional-advice claims**. founder does not produce legal,
  financial, tax, or clinical advice (ADR-0036 Non-Goal 6); flag
  regulated-domain revisions as needing a qualified professional.
