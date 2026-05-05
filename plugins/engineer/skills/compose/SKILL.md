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

## When invoked by command (`/engineer:compose`)

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

---

## Cross-plugin handoff suggestion

If composing requires **durable cited reference material** (e.g.,
RFC text for a network-protocol implementation, design system
spec for a UI build, standard library reference for a low-level
implementation), and the `research@agentic-plugins` plugin is
installed, suggest running `/research:research <topic>` first to
capture the reference as a cited brief, then resume composition
with that brief grounding implementation choices. Per
ADR-0010 §5, this is informational only; no automatic invocation.

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
