---
name: investigate
description: "Gathers evidence, inspects context, scans codebases, probes references, and produces durable cited briefs from external sources — the engineer persona's evidence-gathering verb. Use when the user wants to understand structure, trace flows, diagnose bugs, find root causes, build a mental model, or research a topic with citations before acting. Trigger phrases include 'explain this codebase', 'how is this structured', 'map the architecture', 'project overview', 'why isn't this working', 'what's causing this', 'debug this', 'find the root cause', 'it's broken', 'unexpected behavior', 'research X', 'cited brief', 'literature review', 'investigate X', '코드베이스 분석', '버그 진단', '원인 분석', '어떻게 되어있어', '리서치', '조사해줘'. Do NOT jump to fixing — investigate first."
---

# Investigate (engineer persona)

The engineer plugin's evidence-gathering verb (per ADR-0010 §2). The
verb covers three recurring engineer activities through profile
sub-modes:

| Profile | What it does | omcc-dev / agentic-plugins equivalent |
|---------|--------------|---------------------------------------|
| `analysis` (default) | Explore an unfamiliar codebase / area to build a structured understanding | omcc-dev `explore` |
| `root-cause` | Diagnose a bug or unexpected behavior through structured hypothesis investigation | omcc-dev `investigate` |
| `cited-brief` | Research a topic with external sources and produce a durable cited brief artifact | absorbs `plugins/research` per [ADR-0014](../../../../docs/adr/0014-plugins-research-deprecation.md) (was a Stage 1 single-verb capability plugin) |

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

1. Inspect the user's request:
   - Mentions of "research X", "cited brief", "literature review",
     "investigate <topic>", "리서치", "조사해줘", or external-sources
     intent → `cited-brief` profile.
   - Mentions of bug / error / "why isn't this working" / unexpected
     behavior → `root-cause` profile.
   - Otherwise → `analysis` profile.
2. Privacy gate: avoid sending proprietary identifiers / internal
   paths / customer data anywhere — including web search queries,
   external fetches, and peer-host dispatch (cited-brief mode).
   Generic technology terms only.

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

For `cited-brief`:
1. Confirm the topic with the user as a single concise statement
   (the user's phrasing, normalized).
2. Draft 1-7 sub-questions that decompose the topic into investigation
   axes. Confirm with the user (or auto-proceed if obvious).
3. Define scope — what the brief covers and explicitly excludes.
4. Existing-directory check per
   `references/output-file-rules.md` — if the resolved per-topic
   directory already exists, ask overwrite / distinct / abort BEFORE
   running web searches (avoids wasted work on a session the user
   will discard). Default on no-response: distinct directory.
5. Privacy gate (re-confirm): the topic + sub-questions are about to
   leave the local host via WebSearch / WebFetch. No proprietary
   identifiers.

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

### Step 3'': Source-tier scan (cited-brief profile)

For each confirmed sub-question, run external evidence gathering
using the 4 source-type taxonomy from
`references/cited-brief-spec.md` § Source Type Taxonomy:
`official-docs`, `standards`, `academic`, and `secondary`.

Collection priority: prefer the three higher-tier types
(`official-docs`, `standards`, `academic`) first; fall back to
`secondary` (vendor docs, recognized technical blogs,
community/anecdotal references) when the higher-tier search is
incomplete. Mark community/anecdotal sources accordingly. Higher-tier
sources also carry more weight in the brief's confidence rating per
the spec.

Use WebSearch + WebFetch. Capture sources in **research-execution
order** — the first source becomes `[1]`, the next new source `[2]`,
etc. Deduplicate URLs canonically. Record title, URL, access date
(`YYYY-MM-DD`), and source type per source.

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
```

Do NOT implement the fix in this skill — investigation produces
findings. The concrete next step is the Active Next-Action Proposal
emitted at completion (see § Completion below), not a fixed handoff.

For `cited-brief`, produce the durable artifact per
`references/cited-brief-spec.md` (canonical structure, citation
conventions, audit checklist) and save it per
`references/output-file-rules.md` (per-topic directory under the
resolved output root, fixed filename `research_brief.md`):

1. Run the **Audit Checklist** before saving — every finding must
   be cited or carry a permitted sentinel; PEER-ONLY claims must be
   Path A (locally verified, `[N]`-cited) or Path B (moved into Open
   Questions); no source-of-discovery labels in the brief artifact.
2. Save to `<resolved-root>/YYYY-MM-DD_<topic-slug>/research_brief.md`.
3. Present a completion summary inline — saved path, sub-questions
   covered, source-tier breakdown, overall confidence, any
   degraded-ensemble note.

The cited-brief profile produces a saved artifact, not a workflow
state write — the artifact is the handoff. Other engineer verbs
(`/engineer:decide`, `/engineer:compose`, `/engineer:critique`,
`/engineer:refine`) consume it as additional context.

---

## When invoked by command (`/engineer:investigate` Claude command or `$engineer:investigate` Codex skill mention)

Full investigation with agent spawning, peer ensemble parallel
analysis, and (when invoked from a workflow command) state writes.

### Step 1: Task Profile

Build the Task Profile per
`../_shared/references/orchestration.md` Step 1, capturing
`Persona: engineer`, `Profile: <profile arg>`, scope, layers, risks,
complexity, and Ensemble Affinity (recorded but not gating —
always-max policy).

For `cited-brief`, scope and layer fields are descriptive only — the
domain's quality dimensions (topic depth, source-tier requirement,
controversy, freshness) do not map onto the file/layer/risk axes
used by code workflows. Affinity remains always-on per
`references/cited-brief-ensemble.md` § Affinity. After the Task
Profile, the cited-brief profile runs the auto-mode Step 2 flow
above (topic confirmation + sub-questions + scope + existing-directory
check + privacy gate) before proceeding to Step 2 below.

### Step 2: Spawn local agents

Follow `../_shared/references/orchestration.md`, targeting:

- `analysis` profile → Analysis Agents (architecture-mapper,
  flow-tracer, dependency-analyzer, pattern-detector — selected by
  scope).
- `root-cause` profile → Investigation Agents (hypothesis-tracer,
  regression-hunter, state-analyzer — at minimum 2 hypotheses from
  distinct failure categories).
- `cited-brief` profile → No subagent spawning. The orchestrator runs
  WebSearch + WebFetch directly per-sub-question (Step 3'' above).
  Local-host evidence-gathering is single-actor here because external
  source retrieval is the work, and parallelizing it across
  read-only-file subagents (which lack web tools) would not help.

Investigation/analysis agents have read-only file tools and no `git`
access. When a hypothesis depends on change history, the orchestrator
collects `git log --oneline -20` and the relevant diffs first and
embeds them in the agent's mission (especially for the
`regression-hunter` pattern; see
`../_shared/references/agent-taxonomy.md`).

Launch all selected agents in parallel (single message, multiple
Agent calls on the orchestrator host). For `cited-brief`, this step
is a no-op — proceed directly to Step 3 (the peer ensemble) and run
the local web-search work simultaneously per Step 3'' above.

### Step 3: Peer ensemble parallel analysis

Simultaneously with local agent dispatch (or, for `cited-brief`, with
the local web-search work in Step 3''), launch the peer ensemble:

- `analysis` profile → **Explore** ensemble point type
  (`../_shared/references/ensemble-protocol.md`)
- `root-cause` profile → **Investigate** ensemble point type
  (`../_shared/references/ensemble-protocol.md`)
- `cited-brief` profile → **research-scan** ensemble point type
  (`references/cited-brief-ensemble.md`). Dispatch goes through
  `plugins/engineer/scripts/peer-runner.mjs run` for command-managed
  ensembles; the prompt carries the topic, confirmed sub-questions,
  scope, and the `<citation_contract>` and `<privacy_contract>` XML
  blocks per the ensemble protocol; the companion is invoked in JSON
  envelope mode via `--prompt-file`.

The peer call is automatic (always-max policy); skills do not pass
`--model` or `--effort` flags.

### Step 4: Collect, evaluate, synthesize

1. Wait for local agents (or, for `cited-brief`, the local
   per-sub-question WebSearch / WebFetch run) to return; collect
   findings.
2. Wait for the peer ensemble background notification; read the peer
   envelope.
3. Synthesize:
   - `analysis` / `root-cause` → per
     `../_shared/references/ensemble-protocol.md` §Base Synthesis
     Categories: `AGREED` / `LOCAL-ONLY` / `PEER-ONLY` / `CONFLICT`.
   - `cited-brief` → per `references/cited-brief-ensemble.md`
     §Synthesis: same base taxonomy; PEER-ONLY claims undergo the
     bidirectional Independence Rule (Path A locally verify and cite,
     Path B move to Open Questions); citation numbering is remapped to
     local capture order (peer's internal labels MUST NOT be copied
     verbatim).
4. For `root-cause`: rank hypotheses by confidence
   (HIGH > MEDIUM > LOW), verify the top result with a targeted
   check before presenting.

### Step 5: Present

Follow the Presentation Mode Protocol
(`../_shared/references/presentation-protocol.md`) before
presenting. Use the same shapes as the auto-activated mode (Step 4
above), at the deeper synthesized fidelity.

For `cited-brief`, the presentation has three possible terminal
outcomes:

- **saved** — audit passed and the brief was written to
  `<resolved-root>/YYYY-MM-DD_<topic-slug>/research_brief.md`. Show
  the saved path, sub-question coverage, source-tier breakdown,
  overall confidence, and any degraded-ensemble note.
- **aborted-at-save** — the user chose abort at the existing-directory
  gate or at a final review prompt. No file written; the synthesized
  brief is shown inline only.
- **aborted-at-scoping** — the user declined the topic, sub-questions,
  or privacy gate before dispatch. No web search / peer dispatch ran.

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

For `cited-brief`, the saved brief artifact
(`<resolved-root>/YYYY-MM-DD_<topic-slug>/research_brief.md`) is
**orthogonal** to any workflow state write — when invoked from a
workflow command, the workflow file gets the phase-note write AND
the brief artifact is saved separately (dual write, no collision).
The brief artifact is never tracked in the workflow's
state-managed body; it is referenced by saved-path only.

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

## Completion — Active Next-Action Proposal

At the end of a successful investigation (the `✓` outcomes, both the
auto-activated and the command path above), emit an **Active Next-Action
Proposal** instead of a fixed next verb, per
`../_shared/references/entry-routing-contract.md` § Active Next-Action
Proposal — derived from these findings, not a fixed table:

```
- selected_next:         <verb | commit | owner decision>
- rejected_alternatives: <1-2 alternatives, each + one-line why-not>
- rationale:             <why best — 본질/근본 (essence/foundation) + Standards/Root-Cause gate>
- evidence_pointers:     <phase notes / files / artifacts — pointers only>
- confidence:            <HIGH | MEDIUM | LOW>
- next_command:          <exact next step: /engineer:<verb> … or $engineer:<verb> for a verb; the commit / owner-decision action otherwise>
```

Typical `selected_next` candidates for investigate: for the `analysis` /
`root-cause` profiles, `/engineer:decide` (2+ approaches),
`/engineer:refine` (an obvious fix), or `/engineer:frame` (reformulate the
question); for the `cited-brief` profile, `/engineer:frame` (scope a
decision from the brief), `/engineer:decide` (choose between surveyed
approaches), or `/engineer:compose` (draft from it). The routing table is
the fallback only when evidence is genuinely neutral — do not end with a
hardcoded "next: X". When `selected_next` is `engineer:decide`, also name
the decision size (`--size=minor|standard|major`) per the contract. The
auto-activated path stays lightweight (ADR-0029 §3): it emits this
proposal shape and routing reasoning without dispatching a peer. The two
aborted cited-brief outcomes (aborted-at-save / aborted-at-scoping) have
no forward result, so they skip the proposal.

---

## Session-level handoff preflight (ADR-0031)

The completion footer — including the ADR-0031 continue-vs-fresh
session-handoff — is **code-emitted** on this verb's terminal path (ADR-0039):
`state.mjs set-terminal` fires the session-handoff sidecar, which renders the
runtime `footer.mjs` on the terminal command's stderr. Do not hand-compose the
footer or hand-pass the projection here; surface the emitted one. On detached
HEAD the sidecar reports "no active branch context" and does not auto-recommend
a fresh session. This mirrors the `/engineer:investigate`
command's preflight so `$engineer:investigate` on Codex surfaces it identically.

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
viable root-cause hypotheses, or two competing readings of the same
evidence, or a non-neutral `selected_next` with 2+ candidates in the
proposal above — surface a **compact multi-axis lens** comparing the
branches across the decisive axes (본질/근본 essence/foundation) + the
size-appropriate supporting axes, instead of a flat list, per
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
- **Source-of-discovery labels in the cited-brief artifact**
  (`cited-brief` profile). The saved brief MUST NOT carry `[Local]`
  / `[Peer]` / `[Both]` markers or any host-specific equivalent.
  Numeric `[N]` citations are the only allowed labeling format in
  Findings and Sources. Workflow phase notes elsewhere may carry
  these labels for orchestration transparency, but the brief artifact
  strips them before the audit gate. See
  `references/cited-brief-spec.md` § Ensemble Label Policy.
- **Decision-bound option comparisons** in the cited-brief profile.
  cited-brief is **topic-bound** evidence gathering — it surveys what
  exists about a topic with citations. Comparing 2+ approaches
  against criteria to pick a path belongs to `/engineer:decide` (or
  `/engineer:frame` when scoping the decision). Mixing a decision
  scaffold into a cited-brief produces a hybrid that is neither
  reusable nor honest.
- **Marketing claims without citation** in the cited-brief artifact.
  Every substantive claim in Findings must trace to a `[N]`-cited
  source OR carry one of the permitted sentinels
  (`[uncited inference]` for the model's own synthesis,
  `[research interrupted — partial coverage]` for tool unavailability).
  Un-cited factual claims attributed to external authority are
  removed before the audit gate.
