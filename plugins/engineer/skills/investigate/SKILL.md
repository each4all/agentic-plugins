---
name: investigate
description: "Gathers evidence, inspects context, scans codebases, and probes references — the engineer persona's evidence-gathering verb. Use when the user wants to understand structure, trace flows, diagnose bugs, find root causes, or build a mental model before acting. Trigger phrases include 'explain this codebase', 'how is this structured', 'map the architecture', 'project overview', 'why isn't this working', 'what's causing this', 'debug this', 'find the root cause', 'it's broken', 'unexpected behavior', '코드베이스 분석', '버그 진단', '원인 분석', '어떻게 되어있어'. Do NOT jump to fixing — investigate first."
---

# Investigate (engineer persona)

The engineer plugin's evidence-gathering verb (per ADR-0010 §2). The
verb covers two recurring engineer activities through profile
sub-modes:

| Profile | What it does | omcc-dev equivalent |
|---------|--------------|---------------------|
| `analysis` (default) | Explore an unfamiliar codebase / area to build a structured understanding | omcc-dev `explore` |
| `root-cause` | Diagnose a bug or unexpected behavior through structured hypothesis investigation | omcc-dev `investigate` |

The profile is set via `--profile=<name>` on `/engineer:investigate`,
or inferred from the user's intent when auto-activated. A missing
profile defaults to `analysis`. An unknown profile value falls back
to `analysis` with a one-line user-facing warning so the user can
correct the typo.

**Core principle**: do NOT modify code until evidence is gathered and
the user has decided what to do with it. Investigation produces
findings; deciding belongs to `/engineer:decide`, composing belongs
to `/engineer:compose`, refining belongs to `/engineer:refine`.

---

## When auto-activated (without command)

Lightweight in-context investigation — no subagent spawning, no peer
ensemble dispatch. The depth is appropriate for a quick scoping pass.

### Step 1: Profile selection

1. Inspect the user's request. If it mentions a bug / error / "why
   isn't this working" / unexpected behavior → `root-cause` profile.
   Otherwise → `analysis` profile.
2. Privacy gate: avoid sending proprietary identifiers / internal
   paths / customer data anywhere. Generic technology terms only.

### Step 2: Survey

For `analysis`:
1. Use Glob to identify directory structure and key file patterns.
2. Read the project's CLAUDE.md / AGENTS.md / README, plus config
   files (package.json, pyproject.toml, Cargo.toml, go.mod, etc.).
3. Identify the primary language, framework, and architecture style.

For `root-cause`:
1. Identify the error message, stack trace, or unexpected behavior.
2. Try to reproduce with Bash if safe and quick.
3. Check recent changes with `git log --oneline -10`.
4. Read the relevant code area.
5. Determine: genuine bug investigation, or simple question? Simple
   questions are answered directly without the rest of this skill.

### Step 3: Three-perspective scan (analysis profile)

Address these three concerns:

- **Architecture**: layers, entry points, key abstractions
- **Flow**: pick the most representative operation and trace it
  end-to-end (where data enters, how transformed, where stored)
- **Conventions**: naming patterns, error handling, testing approach,
  style/formatting

### Step 3': Multi-hypothesis scan (root-cause profile)

Generate 2+ hypotheses from distinct failure categories
(code logic / state-data / environment-config). For each hypothesis:
- What evidence would confirm it?
- What evidence would refute it?
- Which file(s) are relevant?

### Step 4: Synthesize and present

Follow the Presentation Mode Protocol
(`../_shared/references/presentation-protocol.md`) before presenting.

For `analysis`, present:
- Architecture overview (2-3 sentences)
- Key files to read first (5-10 paths with why each matters)
- Main data/request flow
- Project conventions
- Notable observations (tech debt, unusual patterns, strengths)

For `root-cause`, present:

```
Symptom:        [what was observed]
Root cause:     [confirmed cause OR top hypothesis with confidence]
Evidence:       [what proves this]
Impact scope:   [how many files/features are affected]
Recommended next step: [/engineer:decide on a fix approach,
                        /engineer:refine if obvious]
```

Do NOT implement the fix in this skill. Hand off to
`/engineer:decide` (when the fix has 2+ viable approaches) or
`/engineer:refine` (when the fix is straightforward).

---

## When invoked by command (`/engineer:investigate`)

Full investigation with agent spawning, peer ensemble parallel
analysis, and (when invoked from a workflow command) state writes.

### Step 1: Task Profile

Build the Task Profile per
`../_shared/references/orchestration.md` Step 1, capturing
`Persona: engineer`, `Profile: <profile arg>`, scope, layers, risks,
complexity, and Ensemble Affinity (recorded but not gating —
always-max policy).

### Step 2: Spawn local agents

Follow `../_shared/references/orchestration.md`, targeting:

- `analysis` profile → Analysis Agents (architecture-mapper,
  flow-tracer, dependency-analyzer, pattern-detector — selected by
  scope).
- `root-cause` profile → Investigation Agents (hypothesis-tracer,
  regression-hunter, state-analyzer — at minimum 2 hypotheses from
  distinct failure categories).

Investigation agents have read-only file tools and no `git` access.
When a hypothesis depends on change history, the orchestrator
collects `git log --oneline -20` and the relevant diffs first and
embeds them in the agent's mission (especially for the
`regression-hunter` pattern; see
`../_shared/references/agent-taxonomy.md`).

Launch all selected agents in parallel (single message, multiple
Agent calls on the orchestrator host).

### Step 3: Peer ensemble parallel analysis

Simultaneously with local agent dispatch, launch the peer ensemble
per `../_shared/references/ensemble-protocol.md`:

- `analysis` profile → **Explore** ensemble point type
- `root-cause` profile → **Investigate** ensemble point type

The peer call is automatic (always-max policy); skills do not pass
`--model` or `--effort` flags.

### Step 4: Collect, evaluate, synthesize

1. Wait for local agents to return; collect findings.
2. Wait for the peer ensemble background notification; read the
   peer envelope.
3. Synthesize per `../_shared/references/ensemble-protocol.md`
   §Base Synthesis Categories — `AGREED` / `LOCAL-ONLY` /
   `PEER-ONLY` / `CONFLICT`.
4. For `root-cause`: rank hypotheses by confidence
   (HIGH > MEDIUM > LOW), verify the top result with a targeted
   check before presenting.

### Step 5: Present

Follow the Presentation Mode Protocol
(`../_shared/references/presentation-protocol.md`) before
presenting. Use the same shapes as the auto-activated mode (Step 4
above), at the deeper synthesized fidelity.

### State write (when invoked from a workflow command)

When `/engineer:investigate` is invoked as a sub-step of an
engineer workflow command (e.g., `/engineer:refine` invoking
investigate first to confirm a root cause, or a future `/start`-
style multi-phase command), the invoking command writes the
investigation results to its workflow file per
`continuity-protocol.md` Phase-boundary Write Rules
(Deliverable D). This skill itself does not write workflow state
— it hands findings to the invoking command, which owns the
write.

When invoked standalone (no parent workflow command), no
workflow file write occurs.

---

## Cross-plugin handoff suggestion

If the user's question needs **durable cited external evidence**
beyond what investigate produces — primary sources, RFCs,
citations, source-tier confidence — and the
`research@agentic-plugins` plugin is installed, suggest running
`/research:research <topic>` first to produce a saved brief, then
resuming investigation with that brief as additional context. Per
ADR-0010 §5, this is informational only; no automatic invocation
occurs from this skill.

---

### Full strike rule

If all local hypotheses AND the peer ensemble's diagnosis are
refuted (`root-cause` profile only):

- Both models have been deployed; the issue requires information
  not available in the codebase.
- Stop and ask the user for additional context (logs, reproduction
  steps, environment details, recent operational changes).
- Do NOT speculate on a cause not grounded in observable evidence.

---

## Anti-patterns (do not produce)

- **Implementing a fix** while still in investigate. Investigation
  produces findings; fixes belong to `/engineer:refine`.
- **Single-hypothesis root-cause investigation** when the symptom is
  ambiguous. Always start from at least 2 distinct failure
  categories.
- **Skipping the peer ensemble** to save tokens. Engineer's policy
  is always-max — the peer is dispatched at every command-mode
  boundary.
- **Modifying code** to verify a hypothesis. Use targeted reads,
  test runs, or log inspection instead. Code changes belong to
  `/engineer:refine`.
