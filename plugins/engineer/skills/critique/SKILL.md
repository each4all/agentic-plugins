---
name: critique
description: "Evaluates an existing artifact against evidence, standards, goals, and failure modes — the engineer persona's critique verb (per ADR-0010 §2 — replaces and extends omcc-dev/parallel-review and omcc-dev/audit). Use for code review, design review, audit. Trigger phrases include 'review this', 'check my code', 'code review', 'quality check', 'how does this look', 'any issues with this', 'review my changes', 'check for problems', 'audit', 'audit the codebase', 'full review', '리뷰', '검토해줘', '어떻게 보여', '이상한 부분', '감사', '전체 검토'."
---

# Critique (engineer persona)

The engineer plugin's critique verb (per ADR-0010 §2). Evaluate an
existing artifact (code change, design, plan, config) from multiple
independent perspectives to catch what single-perspective review
misses.

| Profile | What it does | omcc-dev equivalent |
|---------|--------------|---------------------|
| (default) | Standard parallel review of a recent change set (working tree or commit) | omcc-dev `parallel-review` |
| `full-codebase` | Adversarial audit of an entire area or codebase, with sub-focus | omcc-dev `audit` |

A verb-level sugar alias `/engineer:audit` may be published per
ADR-0010 §3 verb-level alias policy, expanding to
`/engineer:critique --profile=full-codebase`. The canonical command
is `/engineer:critique`.

The profile is set via `--profile=<name>` on `/engineer:critique`,
or inferred from the user's intent when auto-activated. A missing
profile means the default (recent diff). An unknown profile value
falls back to default with a one-line user-facing warning.

For `full-codebase` profile, an additional sub-profile (`security`,
`performance`, `code-quality`, `debt`, `full`) narrows the
adversarial focus per `../_shared/references/ensemble-protocol.md`
§Adversarial-scan focus text taxonomy.

**Core principle**: validity is the orchestrator's judgment. When
synthesizing findings (in both modes below), judge each finding's
validity yourself — do not ask the user "is this an issue?". Drop
invalid ones; surface valid ones by severity. The user reviews the
consolidated, already-judged output. When the fix approach involves
2+ viable alternatives, route through `/engineer:decide`.

---

## When auto-activated (without command)

Lightweight in-context review — no subagent spawning, no peer
ensemble dispatch. The orchestrator evaluates each selected
perspective directly in context, so the orchestrator's own git
tools cover the diff.

### Step 1: Identify what to review

For default profile, collect the full change set:

- `git diff --stat` for scope overview
- `git diff --cached` + `git diff` for staged and unstaged hunks
  (together these handle partially staged files that
  `git diff HEAD` can mask)
- `git ls-files --others --exclude-standard` + `Read` each untracked
  file

If there are no uncommitted changes, ask the user what to review.

For `full-codebase` profile, identify the area in scope (a
directory, a feature, the entire repo) and select the sub-profile
focus.

### Step 2: Determine review perspectives

Select perspectives from
`../_shared/references/agent-taxonomy.md` based on the scope of
changes and risk areas. Default candidates: `correctness` and
`conventions`. Add specialist perspectives only when the task's
risk areas apply.

Evaluate each perspective directly in context (auto-activated mode
is meant to be lightweight; subagent dispatch runs under command
mode).

### Step 3: Synthesize

1. Merge findings from all perspectives.
2. Remove duplicates.
3. Sort by severity (CRITICAL > MAJOR > MINOR > SUGGESTION).
4. Follow the Presentation Mode Protocol
   (`../_shared/references/presentation-protocol.md`) before
   presenting.
5. Present consolidated review.

### Output format

```
## Review Summary
[1-2 sentence overall assessment]

## Critical Issues
- [file:line] [perspective] — [description]

## Major Issues
- [file:line] [perspective] — [description]

## Suggestions
- [file:line] [perspective] — [description]

## Looks Good
- [what was done well]
```

Do NOT fix issues in this skill. Fixing belongs to
`/engineer:refine` (when the fix is straightforward) or
`/engineer:decide` followed by `/engineer:refine` (when the fix has
2+ viable approaches).

---

## When invoked by command (`/engineer:critique`)

Full review with subagent dispatch and peer ensemble parallel
analysis.

### Step 1: Collect change context

Reviewer subagents have read-only file tools and do not run `git`
themselves. The orchestrator collects the change set first and
embeds it in each reviewer's mission:

For a single commit-pending review:

- `git diff --cached` — staged hunks
- `git diff` — unstaged hunks (collected separately to capture
  partially-staged files that `git diff HEAD` can mask)
- `git ls-files --others --exclude-standard` — untracked new files
- Read each untracked file with the `Read` tool so its contents are
  part of the review context.

For an entire-branch review:

- `git diff [base]...HEAD` — the full branch diff. Note untracked
  files separately; they should typically be committed before merge.

For `full-codebase` profile, the orchestrator collects the
relevant files in scope.

### Step 2: Spawn local agents

Follow `../_shared/references/orchestration.md`, targeting Review
Agents based on the implementation's scope and risk areas. Include
diff hunks and file paths in each reviewer's mission prompt so the
agent can evaluate before/after behavior rather than only current
contents. Launch all selected reviewers in parallel.

### Step 3: Peer ensemble parallel analysis

Simultaneously with subagent dispatch, launch the peer ensemble per
`../_shared/references/ensemble-protocol.md`:

- Default profile → **Review** ensemble point type (peer `task`
  invocation with the Review prompt template per
  `../_shared/references/ensemble-protocol.md` §Review)
- `full-codebase` profile → **Adversarial-scan** ensemble point
  type (peer `task` invocation with the Adversarial-scan prompt
  template + sub-profile focus text per
  `../_shared/references/ensemble-protocol.md` §Adversarial-scan)

The peer call is automatic (always-max policy); skills do not pass
`--model` or `--effort` flags.

### Step 4: Synthesize

After agents return:

1. Collect the peer ensemble result.
2. Deduplicate findings across all sources.
3. Unify severity ratings.
4. Label sources per
   `../_shared/references/ensemble-protocol.md` §Base Synthesis
   Categories.

### Step 5: Present

Follow the Presentation Mode Protocol
(`../_shared/references/presentation-protocol.md`) before
presenting. Use the same output shape as auto-activated mode.

Do NOT fix issues in this skill. Fixing is handled by
`/engineer:refine` (per the invoking command's flow).

### State write (when invoked from a workflow command)

When `/engineer:critique` is invoked as a sub-step of a workflow
command, the invoking command writes the findings to its workflow
file per `continuity-protocol.md` Phase-boundary Write Rules
(Deliverable D). This skill itself does not write workflow state —
it hands findings to the invoking command, which owns the write.

When invoked standalone, no workflow file write occurs.

---

## Cross-plugin handoff suggestion

If critique requires **durable cited reference material** (e.g.,
security best practices to evaluate against, standards documents
to compare implementation choices, framework guidelines for the
`conventions` perspective), and the `research@agentic-plugins`
plugin is installed, suggest running `/research:research <topic>`
first to capture the review criteria as a cited brief, then resume
critique with that brief grounding the finding severity. Per
ADR-0010 §5, this is informational only; no automatic invocation.

---

## Anti-patterns (do not produce)

- **Asking the user "is this an issue?"** Validity is the
  orchestrator's judgment. Drop invalid findings; surface valid
  ones by severity.
- **Single-perspective review** when the task's risk profile
  warrants more (e.g., reviewing an auth refactor without a
  `security` perspective).
- **Fixing in the same skill**. Critique produces findings;
  `/engineer:refine` applies fixes.
- **Skipping the peer ensemble** in command mode. Engineer's
  policy is always-max.
- **Surface-level severity inflation**. CRITICAL is reserved for
  defects that block correctness or safety; SUGGESTION is for
  improvements that don't gate merge.
