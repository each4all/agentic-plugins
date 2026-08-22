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

### Step 4: Present and confirm

Follow the Presentation Mode Protocol
(`../_shared/references/presentation-protocol.md`) before presenting.

For `plan`: present the full task list as a single decision item
(the plan), with a recommendation on first task to start.

For `code`: present the diff per task as you go; ask for confirmation
before moving to the next task when the diff is non-trivial.

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

Follow the Presentation Mode Protocol
(`../_shared/references/presentation-protocol.md`) before presenting.

### State write (when invoked from a workflow command)

When `/engineer:compose` is invoked as a sub-step of a workflow
command, the invoking command writes the plan / task list /
implementation progress to its workflow file per
`continuity-protocol.md` Phase-boundary Write Rules (Deliverable D).

When invoked standalone, no workflow file write occurs.

### Layer 2 commit-manifest recording (`code` profile only, command-mode only — ADR-0028 §Layer-2)

When this skill runs in `code` profile **and** is invoked as a sub-step
of a workflow command (i.e., `$ACTIVE` is bound to the workflow file),
record every Write/Edit on a tracked path into the workflow's
`commit_manifest` so Phase 7 can intersect the manifest with
`git_changes` and stage only the workflow-intended files:

```bash
# After each Write or Edit operation on a tracked path during the
# RED-GREEN-REFACTOR loop, append a manifest entry:
node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" record-composed-file \
  --workflow-path "$ACTIVE" \
  --path "<repo-relative path>" \
  --op create   # or "edit" for an existing file
```

The CLI subcommand is a no-op when `--workflow-path ""` is passed
(standalone-mode boundary). `--op` is `create` for a newly added file
and `edit` for a modification of an existing tracked file. The helper
re-uses `validate-commit.mjs#assertSafePath` to reject pathspec
injection at the write boundary (ADR-0028 N1).

`plan` profile composes the plan artifact itself (a state-write through
`state.mjs append`, not a commit-manifest entry). Only `code` profile's
file edits produce commit_manifest rows.

---

## Completion — Active Next-Action Proposal

At the end of a successful compose (both the auto-activated and the
command path above), emit an **Active Next-Action Proposal** instead of a
fixed next verb, per `../_shared/references/entry-routing-contract.md`
§ Active Next-Action Proposal — derived from this artifact, not a fixed
table:

```
- selected_next:         <verb | commit | owner decision>
- rejected_alternatives: <1-2 alternatives, each + one-line why-not>
- rationale:             <why best — 본질/근본 (essence/foundation) + Standards/Root-Cause gate>
- evidence_pointers:     <phase notes / files / artifacts — pointers only>
- confidence:            <HIGH | MEDIUM | LOW>
- next_command:          <exact next step: /engineer:<verb> … or $engineer:<verb> for a verb; the commit / owner-decision action otherwise>
```

Typical `selected_next` candidates for compose: `/engineer:critique` to
review the artifact — or, for a completed `plan` profile,
`/engineer:compose --profile=code` to implement it. The routing table is
the fallback only when evidence is genuinely neutral — do not end with a
hardcoded "next: X". When `selected_next` is `engineer:decide`, also name
the decision size (`--size=minor|standard|major`) per the contract. The
auto-activated path stays lightweight (ADR-0029 §3): it emits this
proposal shape and routing reasoning without dispatching a peer.

---

## Session-level handoff preflight (ADR-0031)

The completion footer — including the ADR-0031 continue-vs-fresh
session-handoff — is **code-emitted** on this verb's terminal path (ADR-0039):
`state.mjs set-terminal` fires the session-handoff sidecar, which renders the
runtime `footer.mjs` on the terminal command's stderr. Do not hand-compose the
footer or hand-pass the projection here; surface the emitted one. On detached
HEAD the sidecar reports "no active branch context" and does not auto-recommend
a fresh session. This mirrors the `/engineer:compose`
command's preflight so `$engineer:compose` on Codex surfaces it identically.

On Claude the Stop hook fires at **every turn end**, so that terminal write puts
the workflow in front of the archive gates at the end of **that same turn**, not
at session close — it archives then if every gate passes, and otherwise stays
marked for a later Stop to re-evaluate. Clearing the marker
(`--terminal-marker false`, with set-terminal's full flag set) works only before
that Stop fires and does not restore the previous phase. On Codex the hook runs
only once the operator has trusted the plugin hooks (`/hooks`), so evaluation
waits. Full contract: `skills/_shared/references/session-handoff.md`
§ Archive timing.

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
`$CLAUDE_PLUGIN_ROOT`. `../checkpoint/SKILL.md` § Claude/Codex command
resolution records the default Codex layout; a non-default install root
means resolving from the running install rather than assuming it. When the resolver CLI still does
not run, keep the decisive axes 본질/근본 (essence/foundation, universal to
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
