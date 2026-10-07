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

If review-driven and findings remain, that informs the Active
Next-Action Proposal at completion (see § Completion below) —
typically `/engineer:critique` again on the changed surface to detect
regressions or newly-exposed issues.

---

## When invoked by command (`/engineer:refine` Claude command or `$engineer:refine` Codex skill mention)

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
     the user whether to address now or defer. A finding an earlier
     refine pass on this workflow already addressed that survives
     verification again is the owner's call (ADR-0063 D4): leave the
     loop, record the `recurring-finding` owner gate with the command's
     Phase 2 owner-decision variant, and stop. Under autopilot (Claude
     only) do not wait for an answer.

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

This skill itself writes no phase note or progress — it hands the
result to the invoking command, which owns the write; its one workflow
write is the commit-manifest recording below.

When invoked standalone, no workflow file write occurs.

### Layer 2 commit-manifest recording (command-mode only — ADR-0028 §Layer-2)

When this skill is invoked as a sub-step of a workflow command (i.e.,
`$ACTIVE` is bound to the workflow file), record every Write/Edit on a
tracked path into the workflow's `commit_manifest` so Phase 7 can
intersect the manifest with `git_changes` and stage only the
workflow-intended files:

```bash
# After each Write or Edit operation on a tracked path during the
# apply-fix loop, append a manifest entry:
node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" record-refine-file \
  --workflow-path "$ACTIVE" \
  --path "<repo-relative path>" \
  --op edit   # or "create" if the refine adds a new file
```

The CLI subcommand is a no-op when `--workflow-path ""` is passed
(standalone-mode boundary). `--op` is `edit` for a modification of an
existing tracked file (the common refine case) and `create` for a
newly added file. The helper re-uses
`validate-commit.mjs#assertSafePath` to reject pathspec injection at
the write boundary (ADR-0028 N1).

---

## Completion — Active Next-Action Proposal

At the end of a successful refine (both the auto-activated and the command
path above), emit an **Active Next-Action Proposal** instead of a fixed
next verb, per `../_shared/references/entry-routing-contract.md`
§ Active Next-Action Proposal — derived from this refinement, not a fixed
table:

```
- selected_next:         <verb | commit | done | owner decision>
- rejected_alternatives: <1-2 alternatives, each + one-line why-not>
- rationale:             <why best — 본질/근본 (essence/foundation) + Standards/Root-Cause gate>
- evidence_pointers:     <phase notes / files / artifacts — pointers only>
- confidence:            <HIGH | MEDIUM | LOW>
- next_command:          <exact next step: /engineer:<verb> … or $engineer:<verb> for a verb; /engineer:commit or $engineer:commit for commit or done; the owner-decision action otherwise>
```

Typical `selected_next` candidates for refine: `/engineer:critique` to
confirm with another review pass, or `commit` when the change is small and
verified — or `/engineer:investigate --profile=root-cause` when a deeper
root cause is suspected. The routing table is the fallback only when
evidence is genuinely neutral — do not end with a hardcoded "next: X".
When `selected_next` is `engineer:decide`, also name the decision size
(`--size=minor|standard|major`) per the contract. The auto-activated path
stays lightweight (ADR-0029 §3): it emits this proposal shape and routing
reasoning without dispatching a peer. The blocked outcome (peer flagged a
regression) pauses for user direction before any forward proposal.

**A finding that recurs** — one an earlier refine pass on this workflow
already addressed survives verification again — is the owner's call:
`/engineer:refine` ends with the `recurring-finding` owner gate instead of a
terminal write, and its Owner decision step records fix-now-or-defer and
clears the gate (`../_shared/references/entry-routing-contract.md` § Owner
gates).

<!-- pipeline:begin refine-finish -->
Run by `/engineer:refine`, the command's last write, `state.mjs
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
`$engineer:refine` on Codex surfaces the footer as
`/engineer:refine` does. Wiring:
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

When this verb reaches a **genuine 2+-branch decision point** — two
viable fix strategies, or two refactor paths, or a non-neutral
`selected_next` with 2+ candidates in the proposal above — surface a
**compact multi-axis lens** comparing the branches across the decisive
axes (본질/근본 essence/foundation) + the size-appropriate supporting
axes, instead of a flat list, per
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
