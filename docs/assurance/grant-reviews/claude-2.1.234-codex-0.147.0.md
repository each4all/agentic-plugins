> **Status: UNVERIFIED — prepared for review, not accepted provenance.**
>
> This document assembles measured inputs for the ADR-0053 §Decision 5 human
> review that the first assurance grant requires. It has **not** itself been
> independently checked, and it must not be cited as `review_provenance` until
> it has been. Its central claims in §2 and §3 are *negative* ones — that a
> given 2.1.234 change does not reach this framework — and a negative is
> exactly the shape that passes vacuously when its control is missing. Each
> such claim below names the control used; a verifier should re-run those
> controls rather than accept the conclusions.
>
> Authored 2026-08-19 by the same session that wrote the post-0.91.1 recovery
> record, which is a standing reason to have someone else check it: that
> session had already argued in prose that the refusal is working as designed.

# Grant review brief — claude 2.1.234 / codex 0.147.0

Prepared for the ADR-0053 §Decision 5 human review that the first assurance
grant requires. Runtime cannot produce this judgement; this document only
assembles measured inputs for it.

## 1. Scope

- **Host tuple under review**: claude `2.1.234` / codex `0.147.0`
- **Against installed**: runtime `0.91.1`; packages companions 0.3.0,
  attention 0.9.0, companions 0.4.0, designer 0.3.4, engineer 0.21.5,
  founder 0.4.4, image 0.2.0, orchestrator 0.13.3
- **Delta since the packaged baseline** (observed 2026-08-16 at claude 2.1.233
  / codex 0.147.0): **exactly one Claude version**, 2.1.233 → 2.1.234.
  Codex is unchanged (`exact`).
- Source: local `~/.claude/cache/changelog.md` (no network fetch performed).
  The 2.1.234 entry carries **51** changelog lines.

Note the review is nominally of the whole PAIR, not just the delta: no grant
has ever existed, so nothing about this pair has been reviewed under the
assurance mechanism before. What makes it tractable is that the packaged
baseline already documents this pair surface-by-surface at 2.1.233; the
incremental judgement is the 2.1.234 delta plus the carried residuals in §4.

## 2. Delta vs the ADR-0053 consumed-surface list — measured

| Surface | Lines in 2.1.234 | Reaches this framework? |
| --- | --- | --- |
| Hooks | **0** | No. Absence verified with a control: the same extractor finds 1 hook line in 2.1.204. |
| Plugin manifest | **0** | No. |
| Marketplace | 1 | **No** — the fix is for `strictKnownMarketplaces` accepting SCP-style *git* sources. Measured: all 8 catalog entries use local relative sources (`./plugins/<name>`); zero git/SCP sources. |
| Permission model | 9 | **Largely no** — see §3. |
| Sandbox | 1 | No contract change (an auto-mode fix that stops *spurious denials* after compaction; strictly an improvement). |
| Subagent / teammate | 2 | Partly — see §3. |
| Tool availability | 1 (`--allowed-tools` via `/tui` restart) | No: the companion passes no tool flags. |

Two structural measurements bound most of the above:

- **The companion is non-interactive.** `companions/claude-companion.mjs` runs
  `claude -p` and passes exactly `--effort --model --no-session-persistence
  --output-format --prompt-file`. It passes **no** permission-mode, sandbox,
  approval, or allow/deny-tool flags. Every 2.1.234 permission line that
  concerns an interactive dialog, the IDE diff tab, the fullscreen renderer,
  `/tui` restart, or Remote Control is therefore structurally outside its path.
- **`CLAUDE_CODE_PROJECT_DIR_NAME` (new in 2.1.234) is not consumed.** Zero
  references anywhere in `plugins/`, `companions/`, `scripts/`, and no code
  resolves a per-project transcript/projects directory path. The ADR-0038
  permission diagnosis is opt-in and was `not_requested` in the recorded proof.

## 3. What the reviewer actually has to judge

Three lines survive the filtering above. None is disqualifying on its face;
each needs a human call.

1. **`/permissions` can now be opened while Claude is working — rule changes
   apply to the rest of the current turn.** This changes *when* permission
   rules take effect. It does not alter the companion (non-interactive), but it
   changes the mental model the ADR-0038 advisor describes to an operator.
   Judgement: does the advisor's causal account of prompts stay accurate when
   rules can change mid-turn?

2. **Session-scoped permission answers (including denies) were being dropped
   when answering background subagent tool permission prompts — now fixed.**
   `plugins/engineer` spawns *native* Claude subagents via the `Agent` tool.
   Since 2.1.232 those spawns are backgrounded by default. This is the same
   area as the carried residual in §4.2, and the fix moves it in a safe
   direction. Judgement: accept as improvement, or probe first.

3. **"Default teammate model" removed from `/config`; agent-team teammates now
   use the leader's model unless the spawn names one.** **Measured not to
   reach this framework**: it spawns plain subagents (`Agent({subagent_type})`,
   3 occurrences) and never agent-team teammates — the only two matches for
   team vocabulary are prose saying agent teams must *not* be the portable
   substrate, plus a compat keyword matcher. Listed so the reviewer can confirm
   the scoping rather than discover it later.

## 4. Residuals the grant would carry (pre-existing, already written as open)

`grant.residuals` is required by the schema — ADR-0053 §Decision 6 notes that
without residuals assurance is strictly harder to satisfy than exactness. The
packaged baseline already records these as unprobed/unverified:

1. **`Notification` hook payload on Claude Desktop and VS Code.** 2.1.233 fixed
   `Notification` hooks not firing for permission prompts on those hosts. The
   attention sensor branches on `notification_type`; the changelog says nothing
   about that field, so payload compatibility on the newly-reached hosts is
   unverified and the matcher was deliberately left unchanged.
2. **Result collection from backgrounded native subagents.** 2.1.232 made
   non-teammate agent spawns background by default; engineer runbooks say
   "wait for local agents" without pinning how results are collected under that
   default. Recorded as unprobed.
3. **Agent teams under the todo-tool withdrawal.** Whether a team on an
   affected model still receives the shared task list is unprobed. (Low
   relevance given §3.3, but it is written into the baseline.)
4. **Non-slash `claude plugin update` path.** The baseline says to treat the
   manual `claude plugin marketplace update` as still required until the
   non-slash update path is directly measured.

## 5. What the grant needs (schema `runtime-host-assurance-1.0`)

Required: `id`, `state`, `reviewed_at`, `review_provenance`, `cohort`,
`packages`, `residuals`.

- `cohort` — an explicit finite set of complete `{claude, codex}` tuples.
  Per-host lists and ranges are deliberately **not** expressible, so the grant
  covers only tuples the reviewer names. Minimum here:
  `[{claude: "2.1.234", codex: "0.147.0"}]`.
- `packages` — the consuming package set and reviewed versions (§1).
- `review_provenance` — the durable identity of this review. Never a version
  comparison, never something runtime derives.
- `residuals` — §4.
- `predicate` — optional extra conditions. **Any key runtime cannot observe
  yields `unassured`**, so scope it only to observable conditions.

## 6. Known consequence of granting

The cohort is a finite tuple set, so the next Claude version the operator
installs falls outside it and reads `unassured` again until a further review
lands. ADR-0053 §Neutral states this explicitly and does not claim to reduce
review latency (ADR-0052 measured review latency at 81.7% of one obligation
loop). Locally observed Claude versions sit on a plateau for a median of
2.2 days; historically the baseline read `current` in 42 of 70 doctor runs
(60.0%) over 46.7 days.

If the reviewer wants fewer laps, the lever available today is naming
**several** already-reviewed tuples in one cohort — not a range, and not a
future version.
