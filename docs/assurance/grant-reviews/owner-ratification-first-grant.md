> **Status: RATIFIED — 2026-08-19 by the repository owner (e16tae).**
>
> This is the durable owner-decision artifact the first assurance grant needs.
> The review brief beside it
> ([claude-2.1.234-2.1.235-codex-0.147.0.md](claude-2.1.234-2.1.235-codex-0.147.0.md))
> is verification *input* and says so in its own §5; runtime checks only that a
> `review_provenance.reference` string is non-empty, so nothing mechanical
> distinguishes an accepted review from an unread one. That distinction is this
> document's job.
>
> The owner reviewed §0–§10 and accepted every decision as written, including
> §5's departure from the cross-host recommendation. The grant authored under
> this ratification carries
> `review_provenance: {kind: "owner-attestation", reference: "docs/assurance/grant-reviews/owner-ratification-first-grant.md@<the squash sha of this document's merge>"}`.
> That sha cannot appear in this file — a document cannot cite its own merge —
> so it is resolved when the grant is authored, and the grant is what pins it.

# Owner ratification — the first assurance grant

Macro `macro-plan-20260818T192357Z-a06395`, subtask ST2. Inputs: the corrected
review brief (PR [#714](https://github.com/each4all/agentic-plugins/pull/714)
plus its retarget extension), a cross-host Brainstorm review, and the
measurements cited inline below.

## 0. The retarget, and why this document exists at all

The macro planned a grant for `{claude 2.1.234, codex 0.147.0}`. **The machine
updated to `2.1.235` while the verification subtask was running** — the binary
was replaced at 05:58 on 2026-08-19, mid-session. This is the failure ADR-0052
measured and the 2026-08-16 baseline row recorded, reproduced inside a single
working session rather than across the 2.2-day plateau the plan assumed.

A grant naming only `2.1.234` would be honest and **unexercisable**: cohort
membership is exact tuple identity, so this machine would read `unassured` and
ADR-0054 §Decision 6's purpose for R2 — exercising the positive path on a real
machine — would go unmet. The owner chose to retarget: review the `2.1.235`
delta as well and let the cohort name both reviewed tuples. That review is §8
of the brief; it adds no residual and changes no judgement.

## 1. Grant, defer, or refuse — **GRANT**

Deferring buys a smaller residual set at the cost of another lap, and the lap
is exactly what just went wrong. Refusing is mechanically identical to
deferring unless documented outside the grant array, and a `revoked` first
grant would be a misuse of a tombstone.

The one argument for deferring is real and is answered in §5: the framework
carries a reproduced companion-contract violation. It is **pre-existing** —
`2.1.233` already shipped a wording the classifier misses — so deferring the
first grant does not fix it, and granting does not create it. ADR-0053
§Decision 6 exists so a reviewer can accept a host with recorded open
questions rather than making assurance strictly harder to satisfy than
exactness.

## 2. Cohort — **both reviewed tuples**

```
[{claude: "2.1.234", codex: "0.147.0"},
 {claude: "2.1.235", codex: "0.147.0"}]
```

Both are reviewed *here*: §2–§7 of the brief cover `2.1.234`, §8 covers
`2.1.235`. This is the only mitigation the brief's §6 identifies — naming
several already-reviewed tuples — and it is not a range. The `2.1.234` binary
is still installed at `~/.local/share/claude/versions/2.1.234`, so the second
tuple also covers a rollback rather than being decorative.

*A cross-host reviewer recommended `2.1.234` only. That recommendation was
made before the retarget, when `2.1.235` was unreviewed; naming an unreviewed
tuple would indeed have claimed more than was done.*

## 3. `review_provenance` — **`owner-attestation`**, this document

```
{kind: "owner-attestation", reference: "docs/assurance/grant-reviews/owner-ratification-first-grant.md@<squash sha of this document's merge>"}
```

`pull-request` was the low-ceremony alternative and is defensible, since
repository convention makes the final PR body the permanent squash body. It
was not chosen because a PR body is not addressable by path from the packaged
baseline, and because the ratification needs to survive as a file a future
auditor can diff. `evidence-record` is unavailable — evidence records are
authored after release and proof, and the existing one records this plane's
*refusal*. `adr` is disproportionate.

## 4. `packages` — **seven concrete consumers, `image` deliberately unbound**

| Package | Version | Why it is bound |
| --- | --- | --- |
| `attention` | `0.9.0` | Desktop/VS Code `Notification` payload (residual 1) |
| `companions` | `0.4.0` | authentication classification (residual 6) |
| `designer` | `0.3.4` | background-notification delivery (residual 7b) |
| `engineer` | `0.21.5` | native subagents + notification delivery (residuals 2, 7a) |
| `founder` | `0.4.4` | background-notification delivery (residual 7c) |
| `orchestrator` | `0.13.3` | background-notification delivery (residual 7d) |
| `runtime` | **release-assigned** | plugin update, transcript scanner, PATH boundary (residuals 4, 5, 8) |

`image` is left unbound on purpose. Its dispatcher calls `codex-companion`
**synchronously** (`plugins/image/scripts/compose-dispatch.mjs`), so it does
not consume the background-notification channel that this delta changed, and
`plugins/runtime/docs/follow-ups.md` records that requiring every installed
plugin is the wrong answer — it would make an unrelated `image` release
invalidate a host grant. The positive verdict will carry
`unbound_packages: ["image"]`, which is the honest signal that a reviewer
bound less than the machine runs. A cross-host reviewer drove this exact
seven-package shape through the real matcher: `issues=[]`, `state=covered`,
`unbound_packages=["image"]`.

**`runtime`'s version is whatever release-please assigns**, not a hardcoded
`0.91.2`. A `fix(plugin/runtime)` commit with no intervening runtime change
predicts `0.91.2`, but the release PR is authoritative — the grant must bind
the version actually cut, or it ships dead on arrival.

## 5. The authentication defect — **accept as `accepted-with-risk`, grant now**

`AUTH_REGEX` in `companions/claude-companion.mjs` requires `please run /login`.
Two expired-Anthropic-profile wordings omit "please", so an expired profile
classifies as `peer_run_error` / exit 1 instead of the contract's
`peer_unauthenticated` / exit 3 — and the operator-facing summary degrades from
`claude reports missing or expired authentication` to the generic `peer exited
with code 1`, with the original wording surviving only in `error.detail`, which
text mode does not expose.

**This decision goes against the cross-host recommendation, and the reason is a
measurement.** That reviewer recommended fixing first: two release events
instead of the three that grant-now → fix → regrant costs. The arithmetic is
right and its premise is not — it assumes the host holds still across the extra
lap. The host moved *inside this session*. Every additional lap before the
first positive observation is another chance for the cohort to go stale, and
that risk is no longer hypothetical here.

Accepted consequences, stated rather than left to be discovered:

- When the classifier is fixed, `companions` changes version and **this grant
  is invalidated** — correctly, by §Decision 8. A new review and a new grant
  will be needed. That is the cost of granting first, and it is accepted.
- The residual is `accepted-with-risk`, **not** `probe-pending`. The defect is
  reproduced, not hypothetical, and `probe-pending` would misdescribe it.

**Note that `probe-pending` does not gate anything.** A grant carrying
`probe-pending` residuals still returns `covered` with `next_action: null`
(`plugins/runtime/scripts/lib/assurance-result.mjs`). It is documentary. If the
owner wants a probe completed *before* coverage, the grant must not exist yet.
This is the single most misreadable property in the decision.

## 6. The PATH boundary — **stated, and carried in a residual**

Assurance is an operator-facing readiness verdict on a machine the operator
controls. It is **not** an attestation against a hostile local root: a shim
first on `PATH` whose `--version` prints a reviewed pair and whose
`plugin list` prints the granted package versions satisfies both cohort
matching and package binding without the packaged baseline being touched.
`AGENTIC_COMPANIONS_ROOT` is the same trust boundary by a different door — it
overrides the installed companion bundle and can execute bytes the bound
plugin version does not represent.

This is recorded as residual 8 rather than only in prose, because a `covered`
verdict projects each residual's `surface`, `consumption`, `disposition` and
`consuming_package` — and **drops the `note`**. The complete boundary
statement therefore goes in `surface`.

## 7. Residuals — eleven objects

Serialized shape per residual: `surface`, `consumption`, `disposition`, and —
for every `consumed` one — a `consuming_package` that `packages` binds.
Duplicate `surface` strings are rejected, which is why row 7 becomes four
package-qualified entries rather than one.

| # | Surface | consumption | disposition | package |
| --- | --- | --- | --- | --- |
| 1 | `Notification` hook payload on Claude Desktop and VS Code | consumed | probe-pending | `attention` |
| 2 | Result collection from backgrounded native subagents | consumed | probe-pending | `engineer` |
| 3 | Agent teams under the todo-tool withdrawal | unadopted | not-applicable | — |
| 4 | Non-slash `claude plugin update` path | consumed | probe-pending | `runtime` |
| 5 | Claude transcript scanner ignores `CLAUDE_CONFIG_DIR` | consumed | **accepted-with-risk** | `runtime` |
| 6 | `AUTH_REGEX` misses the Anthropic-profile expiry family | consumed | **accepted-with-risk** | `companions` |
| 7a | Background-notification delivery format (engineer) | consumed | probe-pending | `engineer` |
| 7b | Background-notification delivery format (designer) | consumed | probe-pending | `designer` |
| 7c | Background-notification delivery format (founder) | consumed | probe-pending | `founder` |
| 7d | Background-notification delivery format (orchestrator) | consumed | probe-pending | `orchestrator` |
| 8 | PATH / `AGENTIC_COMPANIONS_ROOT` trust boundary | consumed | accepted-with-risk | `runtime` |

Rows 5 and 6 are `accepted-with-risk` rather than `probe-pending` because both
defects are *proven*, not unknown. Row 3 takes no package: an `unadopted`
residual naming one is rejected by the contract.

## 8. Judgements accepted without a residual

The brief's §3 lists judgements that are not open questions and therefore get
no residual row. They are accepted explicitly here so the acceptance is
recorded rather than implied:

- **§3.1** `/permissions` openable mid-turn, rules applying to the rest of the
  turn — accepted; the ADR-0038 advisor's account remains accurate because it
  describes prompts, not rule lifetime.
- **§3.2** the background-subagent permission-answer fix — accepted as a
  safe-direction improvement.
- **§3.6** the interactive / IDE / fullscreen / Remote Control permission
  lines, and `2.1.235`'s entries 5 and 12 — accepted. Each is a fix in the safe
  direction, and none changes a contract this framework encodes. They are in
  scope (the 57 command runbooks run in the main interactive session) and
  **cannot be scoped out**: there is no OS or integration predicate, and every
  non-empty predicate the schema permits is unobservable and would yield
  `unassured`.
- **`2.1.235` entry 6** (`Agent` tool `subagent_type`) — measured not to reach
  this framework; every call site names the argument.

## 9. Grant identity

- `id`: `claude-2-1-234-235-codex-0-147-0`
- `state`: `granted`
- `reviewed_at`: `2026-08-19`
- `predicate`: **omitted** — not optional. Every permitted key is unobservable
  and any non-empty predicate yields `unassured`.

## 10. What this ratification does not claim

- It does not claim the reviewed packages are defect-free; residuals 5, 6 and 8
  record known defects accepted with risk.
- It does not claim any probe was completed. Four `probe-pending` rows are open
  questions carried into a positive verdict.
- It does not claim coverage of any host pair outside the two named tuples. The
  next Claude release falls outside the cohort and reads `unassured` — by
  design, and stated in ADR-0053 §Neutral.
- It does not attest against a hostile local root (§6).
