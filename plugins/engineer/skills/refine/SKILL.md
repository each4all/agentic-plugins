---
name: refine
description: "Applies feedback, repairs defects, improves fit, iterates after critique — the engineer persona's refinement verb (per ADR-0010 §2 — replaces and extends omcc-dev/fix). Use to fix bugs, apply review findings, address feedback. Trigger phrases include 'fix this', 'fix the bug', 'address this issue', 'apply this fix', 'implement the fix', 'make this work', 'resolve the issue', 'apply the feedback', 'incorporate the suggestions', 'address the review findings', '고쳐줘', '수정', '버그 잡아줘', '리뷰 반영', '피드백 적용'."
---

# Refine (engineer persona)

The engineer plugin's refinement verb (per ADR-0010 §2). Apply a
fix, incorporate feedback, repair a defect, iterate on an existing
artifact based on critique findings. Refine assumes the *what to
change* is known; the work is doing it correctly and verifying.

This verb takes no `--profile` argument — refine is single-mode by
design (the verb's purpose is faithful application + verification
of an already-decided change). Sub-discipline context is supplied
through the orchestrator-level Task Profile per
`../_shared/references/orchestration.md`, not via per-call profile
arguments.

**Core principle**: do not modify code until the root cause is
confirmed. When refining a bug fix, the upstream contract is:

```
investigate (root-cause profile)  →  decide (if 2+ fix approaches)
                                  →  refine
```

Skipping investigate produces fixes that paper over symptoms.
Skipping decide when alternatives exist locks in an undeliberated
fix approach.

---

## When auto-activated (without command)

Lightweight in-context refinement — no subagent spawning, no peer
ensemble dispatch.

### Step 1: Verify upstream

Before applying a change, confirm:

- For bug fixes: a confirmed root cause from
  `/engineer:investigate --profile=root-cause`. If no root cause
  is confirmed, suggest running investigate first.
- For review-driven changes: a finding list from
  `/engineer:critique` (or equivalent feedback document).
- For decision-driven changes: the decision is confirmed via
  `/engineer:decide` (when 2+ viable approaches existed).

If multiple findings or feedback items are pending, present them
as a list and confirm with the user which to address now (apply
all? subset? defer the rest?).

### Step 2: Apply the fix

For each item being addressed:

1. State the change before applying it: "Plan: edit
   `<file>:<line>` to <action> because <reason>."
2. Apply the change with Edit (preferred) or Write (when creating
   new files).
3. If the change is non-trivial, present the diff and confirm
   before moving to the next item.
4. For straightforward single-finding fixes, apply directly and
   verify with tests.

When the fix approach involves 2+ viable alternatives, do NOT
choose silently — route through `/engineer:decide` first.

### Step 3: Verify

1. Run the relevant test suite (if available) and confirm green.
2. If the fix transformed a pattern (rename, refactor), Grep for
   the old pattern to confirm 0 remaining occurrences.
3. Run any additional sanity checks the change calls for (a build,
   a lint, a manual reproduction).

If verification fails, return to Step 2 and report the failure to
the user. Do NOT mark the refinement complete on a failed verify.

### Step 4: Present the result

Follow the Presentation Mode Protocol
(`../_shared/references/presentation-protocol.md`) before
presenting.

Present:

```
## Refinement Summary
- Applied: [N findings / 1 fix / etc.]
- Verified: [test results, regression checks]
- Deferred: [items not addressed and why]
```

If review-driven and findings remain, suggest running
`/engineer:critique` again on the changed surface to detect
regressions or newly-exposed issues.

---

## When invoked by command (`/engineer:refine`)

Full refinement with peer ensemble verification and (when invoked
from a workflow command) state writes.

### Step 1: Task Profile

Build the Task Profile per
`../_shared/references/orchestration.md` Step 1.

### Step 2: Apply the fix

Follow Step 2 above. If the change is non-trivial, the orchestrator
may dispatch local subagents (e.g., `correctness` or `conventions`
perspective on the diff in progress) — typically only on large
refinements.

### Step 3: Peer ensemble parallel verification

Launch the peer ensemble per
`../_shared/references/ensemble-protocol.md` using the
**Refine-verify** ensemble point type (peer `task` invocation with
the Refine-verify prompt template per
`../_shared/references/ensemble-protocol.md` §Refine-verify). The
peer independently verifies the applied patch; the orchestrator
may run its own focused review in parallel.

The peer call is automatic (always-max policy); skills do not pass
`--model` or `--effort` flags.

### Step 4: Synthesize

After both sides return:

1. Run the test suite.
2. Collect the peer review.
3. Synthesize per
   `../_shared/references/ensemble-protocol.md` §Base Synthesis
   Categories.
4. Resolve any new findings:
   - Straightforward → apply inline (return to Step 2).
   - 2+ viable approaches → route through `/engineer:decide`.
   - Re-occurring → report as a design-level issue and discuss with
     the user whether to address now or defer.

Loop Steps 2-4 until no new findings emerge.

### Step 5: Present

Follow the Presentation Mode Protocol
(`../_shared/references/presentation-protocol.md`) before
presenting. Use the same shape as auto-activated mode.

### State write (when invoked from a workflow command)

When `/engineer:refine` is invoked as a sub-step of a workflow
command, the invoking command writes:

- The applied fix (file:line, summary) to the workflow file.
- The verification result (tests passing, peer review verdict).
- For bug-fix workflows: the resolution commit SHA at terminal
  state.

per `continuity-protocol.md` Phase-boundary Write Rules
(Deliverable D). This skill itself does not write workflow state —
it hands the result to the invoking command, which owns the write.

When invoked standalone, no workflow file write occurs.

---

## Cross-plugin handoff suggestion

Refine consumes evidence already gathered upstream by investigate /
frame / decide; this verb does not initiate research handoff
itself. If new external evidence is needed mid-refinement (e.g.,
the fix uncovers an unknown about a third-party API contract),
return to `/engineer:investigate` first — and from there route
through `/research:research` if durable cited evidence is
warranted, per ADR-0010 §5.

---

## Anti-patterns (do not produce)

- **Refining before root cause is confirmed** for bug fixes.
  Apply the upstream contract: investigate → decide (if needed) →
  refine.
- **Choosing silently between fix alternatives** when 2+ viable
  approaches exist. Route through `/engineer:decide`.
- **Marking refinement complete on a failing verify**. If tests
  fail, the refinement is not done.
- **Skipping the peer ensemble** in command mode. Engineer's
  policy is always-max.
- **Patching the symptom instead of the root cause** to make a
  test pass. If the change does not address the confirmed root
  cause, return to investigate.
