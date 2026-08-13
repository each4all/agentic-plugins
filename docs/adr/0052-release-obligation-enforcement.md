# ADR-0052: Enforcing the baseline release obligation — history/tag reconciliation, and why Alternatives D stays deferred

## Status

Accepted (2026-08-13). Implemented by `scripts/check-release-obligation.mjs`
and gated by `tests/scripts/test-release-obligation.mjs`.

## Context

[ADR-0051](0051-host-parity-baseline-source.md) §Decision 2 made a change to
`plugins/runtime/docs/host-parity-baseline.md` require a `plugins/runtime`
release before it is in force, and its §Out of scope recorded that nothing
enforces this: *"nothing in CI, release-please, or the validators fails when a
packaged asset changes without a version change, and `16b1833` is the
counterexample that motivated this ADR."* This ADR decides the enforcement, and
re-judges ADR-0051 §Alternatives D against the trigger that ADR named for it.

The obligation has now been exercised once, deliberately, and measured. Every
number below is reproducible from this repository plus the npm registry; none
is an estimate. They are what the decision rests on.

### One premise was disproved before any candidate was drawn

The natural check — *a protected asset changed **and** the package version
changed in the same diff* — cannot work here. In this repository a feature PR
never changes the version; release-please changes it later, in a separate PR.
Such a check rejects every legitimate refresh, and exempting source PRs re-opens
the hole it exists to close. Every candidate must therefore be a **promotion
invariant**, evaluated across the merge→release boundary, not a same-diff
coupling.

### What the counterexample actually was

`16b1833` is more specific than "the baseline never shipped". Its baseline blob
is **byte-identical** to the blob at tag `plugin-runtime-v0.90.0`: the change
did ship, 54.0 hours later, riding an unrelated
`feat(plugin/runtime): packaged host-parity baseline as the single authority`.
The release PR that merged in between (`fd7ab8e`) bumped designer, engineer,
founder and orchestrator and left runtime at `0.89.0`, which confirms the
mechanism — a `docs:` type routes no release.

The defect is therefore a **54-hour divergence window**, closed by luck rather
than by obligation. It is the second-worst window in the project's history, and
its shape is a commit that bundled a post-release recovery with an asset
refresh and took the recovery's `docs:` type.

### The measured cost of one full obligation

Publish → fully recovered, for the Claude Code `2.1.227` refresh:

| Segment | Cost |
|---|---|
| detection lag (host publish → observation snapshot) | 7.03h · 13.6% |
| refresh authoring | 0.63h |
| review/merge wait (refresh PR #688) | 20.95h |
| release automation (merge → tag) | 0.10h |
| catalog + stage-doc sync | 0.03h |
| owner install + verification snapshot | 0.43h |
| doctor proof re-record | 0.27h |
| recovery authoring | 0.96h |
| review/merge wait (recovery PR #690) | 21.43h |
| **total** | **51.84h** |

Rolled up: actual work 2.30h (4.4%), human review/merge latency 42.38h (81.7%),
detection lag 7.03h (13.6%), and **release automation 0.13h — 0.3%**.

That last figure is not a fluke of one loop. Across **all 163** release commits
in this repository, the median time from the preceding `main` commit to the
release commit is **0.08h (4m48s)**; 88% land inside 15 minutes and 96% inside
an hour.

### 51.84h is two obligations stacked, and only one of them is ADR-0051's

- **ADR-0051 §Decision 2** — a baseline change must ship in a release. Marginal
  cost: **0.13h**.
- **`AGENTS.md` §Release process** — *any* `plugins/runtime` version bump makes
  `main` red on `proof-not-recorded` until a real `runtime:doctor` proof is
  re-recorded against the new install (`scripts/sync-doc-versions.mjs:306`).
  Marginal cost: **~23.09h**. This obligation is independent of ADR-0051; a
  baseline-only patch release triggers it exactly as a code release would.
- **Present under every design** — detection 7.03h + authoring 0.63h + review
  20.95h = **28.61h**.

### The loop cannot outrun the host, and that is not the release's fault

Claude Code's publish gaps over the twelve intervals `2.1.217`..`2.1.229`
(re-queried from npm; a clean checkout must re-query rather than trust a stored
copy) are 2.7, 7.0, 20.8, 21.5, 22.3, 24.0, 25.7, 26.2, 26.8, 44.3, 67.1 and
239.1 hours — median 24.9h, mean 44.0h.

Modelling a loop that begins L hours after a publish and takes T hours as
landing on a current baseline only when the gap exceeds L+T: with the measured
L=7.03h and T=22.15h, the loop lands current on **3 of 12** publishes (2 of 11
excluding the single 239h publishing pause). `2.1.228` was published 13.78h
after the observation and 7.80h **before** the refresh merged, so the released
baseline was stale on arrival; `2.1.229` was published 5.31h **before** the
evidence record describing the non-convergence merged. At the time of writing
the machine runs `2.1.229` against a released baseline of `2.1.227`.

### How often the obligation is actually violated

Across the 38 changes to the baseline blob in this repository's history, the
divergence window between the repository copy and the last released packaged
copy has a median of **5.3h** and a mean of 17.6h; **9 exceeded 24h and 5
exceeded 48h**. The obligation is mostly self-satisfying today, because runtime
releases roughly every 15 hours for other reasons and the baseline rides along.
What ADR-0051 asks for is the conversion of that luck into a guarantee.

### What "enforcement" can mean here

`main` carries **no branch protection** and no required status checks
(`GET /branches/main/protection` → `404 Branch not protected`). A PR-time check
therefore cannot block a merge; it can only paint a check red. This is the
single most important constraint on the candidate field, because it means a
PR-time gate and a scheduled detector have the **same** mechanical enforcement
power, and differ only in cost.

### The scope floor, measured rather than assumed

ADR-0051 §Decision 3 extends the rule to "any packaged asset a runtime command
reads to reach a verdict". Reading the code rather than inferring, those assets
are:

| Asset | Owning package |
|---|---|
| `docs/host-parity-baseline.md` | `plugins/runtime` |
| `data/plugin-set.json` | `plugins/runtime` |
| `data/schemas/*.json` (7 files) | `plugins/runtime` |
| `data/runtime-floors.json` | **`plugins/attention`** |

Everything else under `plugins/runtime/docs/` — including
`machine-bootstrap-contract.md`, `settings-report-contract.md`,
`artifact-policy.md`, `completion-output-contract.md`, `footer-contract.md`,
`codex-capability-baseline.md` and `usage-records-source-map.md` — appears only
inside operator-facing message strings and comments. They are documentation
pointers, not verdict inputs.

Of those ten verdict inputs, **only the baseline has ever been changed by a
non-release-routing commit.** `plugin-set.json`, the seven schemas and
attention's `runtime-floors.json` have moved exclusively under `feat`/`fix`
commits, because they change only as part of code work and are therefore
already coupled to a release structurally. The baseline is the sole asset that
is refreshed on its own, by an observation loop rather than by code work, and
that is precisely what exposes it.

## Decision

**Enforcement is a history-and-tag reconciliation check that derives release
debt from immutable Git history, not a PR-time metadata gate. ADR-0051
§Alternatives D stays deferred, with its trigger now measured rather than
assumed.**

1. **Alternatives D is re-judged and remains deferred.** ADR-0051 deferred D
   against a two-clause trigger, and both clauses now measure negative.
   *"Too costly in practice"*: the release obligation costs 0.13h — 0.3% of the
   loop, and a 4m48s median across 163 releases. *"Faster than runtime can
   release"*: runtime releases in six minutes. The baseline is changing faster
   than **reviewed acceptance** can land, which D does not remove — its own
   design keeps a human-reviewed acceptance record. Even granting D everything
   downstream of the refresh merge for free, activation lands 28.61h after
   publication and still clears only 3 of 12 host-publish gaps, an 18.8%
   freshness duty cycle against the measured 18.4%. **D buys no convergence.**

   This is a deferral, not a rejection: ADR-0051's assessment of D as sound
   stands, and §Alternatives below records a concrete design that satisfies
   §Decision 1 so the next reader does not have to re-derive it. Re-trigger D
   if item 6's proof-coupling follow-up is refused, or is attempted and fails.

2. **The protected asset set is defined by directory, not by enumeration.**

   | Protected | Owning package |
   |---|---|
   | `plugins/runtime/docs/host-parity-baseline.md` | `plugins/runtime` |
   | `plugins/runtime/data/plugin-set.json` | `plugins/runtime` |
   | `plugins/runtime/data/schemas/**` | `plugins/runtime` |

   A directory pattern rather than a file list, deliberately. An enumerated
   list has to be kept in sync with `PACKAGED_SCHEMA_FILES`, and this
   repository already has a live instance of that failure mode —
   `check-doc-evidence.mjs`'s `EVIDENCE_DOCS` is a literal array that does not
   expand globs, which is one of the two reasons ADRs are not yet in its scope.
   Directory protection also settles the one genuinely ambiguous member:
   `runtime-plugin-set-1.0.json` is registered in `PACKAGED_SCHEMA_FILES`
   (`schema-validate.mjs:636`) but is loaded today only by tests, because
   `plugin-set.mjs` validates with a hand-written semantic checker. Deciding
   its membership by whether today's call graph happens to reach it is the same
   base-rate reasoning this ADR rejects elsewhere; the directory covers it, and
   covers the next schema added without an edit.

3. **`plugins/attention/data/runtime-floors.json` is deliberately out of first
   scope.** It is a genuine verdict input — `session-readiness.mjs:32` resolves
   and reads it — but it is owned by a different release-please package, so
   covering it requires an asset→owning-package registry and a cross-package
   promotion rule. That is its own decision (item 6).

4. **The two plugin manifests are promotion evidence, never protected
   triggers.** `.claude-plugin/plugin.json` and `.codex-plugin/plugin.json` are
   what release-please rewrites to *discharge* an obligation. Treating a change
   to them as a new obligation recurses without end. The check reads them as
   evidence and never as a trigger.

5. **The check.** For every commit after an adoption epoch that changes a
   protected path, the newest reachable `plugin-runtime-v*` tag must advance
   the runtime manifest **and** contain the protected tree accumulated before
   it. At `HEAD` the state classifies as one of:

   - *fulfilled* — a reachable tag carries the current protected tree;
   - *release in flight* — manifests advanced, tag not yet cut;
   - *outstanding debt* — same released version, different protected tree.

   Outstanding debt fails. Three properties are load-bearing:

   - **Fail closed on absent history.** A shallow checkout or missing tags must
     fail, never pass. `check-doc-evidence.mjs`'s `gitHistoryAvailable` states
     the reason exactly — *"a check that silently no-ops in CI is worse than no
     check, since it reads as coverage"* — and `full-tests.yml` already sets
     `fetch-depth: 0` for its sake.
   - **An adoption epoch is required.** Without one the check retroactively
     condemns 24 of 38 historical baseline changes and main is red from the
     first run. The epoch is this ADR's implementing commit.
   - **The post-tag assertion runs inside the release workflow.** A push
     authenticated with `GITHUB_TOKEN` does not trigger workflows, so a check
     that only listens on `push`/`pull_request` never sees the release commit.
     `release-please.yml` already solves this for the sibling gate, running
     `check-doc-evidence.mjs` inline before it pushes, with the reason in a
     comment. The new check joins it there.

   Main going red between a protected change and its release is **the intended
   signal**, not a defect — the same posture `release-please.yml` already
   documents for the proof-coupled assertion.

6. **Three follow-ups are recorded rather than folded in**, because each is a
   decision of its own and none is enforcement:

   - **Proof-coupling scope.** ~23.09h of the measured 51.84h comes from
     `sync-doc-versions.mjs:306` demanding a re-recorded installed proof after
     *any* runtime bump. A baseline-only patch release moves no code. Scoping
     that obligation is the single largest cost lever measured here, and it is
     also what would make D's remaining argument purely aesthetic.
   - **Patch-tolerance alignment.** `check-host-version-drift.mjs` treats a
     host *patch* difference as informational within a 14-day window; `doctor`
     (`:1184`) and `compat` (`:405`) treat any difference as immediately stale.
     The 51.84h loop was triggered by a patch bump. Aligning the runtime policy
     — direction-aware, so a rollback still flags, which `compareSemver`
     already supports — would drop the obligation's firing rate to changes the
     loop can actually keep up with.
   - **Cross-package scope.** Item 3's asset→owning-package registry, and the
     second tier of rendered distributed behavior
     (`receivers/codex-notify-shuttle.mjs`, `codex-notify-chain.mjs`,
     `agentic-statusline.mjs`), which commands read to render operator-
     installable artifacts but which are not verdict inputs under §Decision 3.

7. **The risk window is merge→tag, and rollback out of it is a forward
   patch.** Between a protected change merging and the tag being cut, the
   bytes have moved and the version has not — the exact state `16b1833`
   produced. Normally the window is minutes, but nothing bounds it: if the
   release workflow fails, `releases_created` is reported only once, so a
   plain re-run repairs nothing and the window stays open until someone
   dispatches the manual repair path `release-please.yml` already documents.

   Rolling a protected asset back inside that window is legitimate. Doing it
   by **reusing or lowering a version is not**, because the released identity
   would then name two different trees — the same "same version, different
   bytes" failure ADR-0051 exists to eliminate, reintroduced from the other
   side. The rollback is a *forward* patch carrying the restored bytes and
   taking the next version. The check fails closed on a version regression
   rather than classifying it, since it is a state the three-state model has
   no honest reading for.

### What implementation settled that the plan had assumed

Three items scoped into this work assumed a diff-shaped gate and dissolve
under the adopted design, which is worth recording so they are not
re-litigated as gaps:

- **PR base absence, and base/head union evaluation.** There is no diff base.
  The check compares two complete protected file *sets* — the set at the
  evaluated ref against the set at the newest reachable tag — so a missing
  base is not a case, and deleting a protected entry moves the digest by
  removing it from the set rather than by being absent from one side of a
  diff. Union evaluation was a workaround for a problem set comparison does
  not have.
- **Rename detection.** Not a heuristic here. Path is a component of the
  digest, so a rename registers whether it moves a file out of the protected
  set or renames it in place with byte-identical contents — the harder case,
  and the one that matters, since schemas are resolved by filename.
- **Multi-package PRs and package creation.** Neither needs a rule. A commit
  is judged only on the protected paths it touches, and the directory pattern
  covers assets added later without an edit to the checker.

### Scope is decided by content, never by walking the commit graph

The first implementation decided epoch scope the obvious way: list the commits
in `<tag>..<ref>` that touched a protected path, and keep the ones descended
from the epoch. Cross-host review disproved it by construction, and the
reproduction is worth keeping because the reasoning looks sound until it runs.

Path-limited `git rev-list` applies git's default history simplification. A
merge that is TREESAME to one parent for the listed paths drops out in favour
of the side-branch commit it came from. So: fork a side branch *before* the
epoch, change a protected file on it, land the epoch on the integration
branch, then merge. The merge is what introduced those bytes to the branch,
but the list names only the side commit — which does not descend from the
epoch — and the filter grandfathers a post-adoption change. `--show-pulls`
restores the merge, but relying on it means the verdict depends on which
commits git decides to attribute a change to.

Both scope questions are therefore answered from **content**:

- **Epoch scope** — the divergence is grandfathered only when the protected
  tree is unchanged since the epoch *and* no release has been cut since. Equal
  trees alone is not sufficient: reverting released bytes back to their
  pre-release state reproduces the epoch's tree exactly while genuinely owing a
  release, so the anchor tag must be unchanged too. Once a release goes by
  without discharging the divergence, the amnesty is spent.
- **In-flight scope** — a manifest advance excuses only the bytes the pending
  tag will actually carry. release-please cuts that tag at the commit that
  advanced the manifest, so comparing the protected tree there against the tree
  at the ref settles it. A protected change landing after that commit is
  provably unreleased *now*, not something to wait for the tag to reveal.

The commit list survives as report only. Nothing reads it to reach a verdict.

### Residual holes, stated rather than implied

§Consequences claims tag immutability and complete history are "asserted
rather than assumed". Complete history is asserted. Tag integrity is asserted
only in part, and the difference matters:

- **A tag must name the version its own commit set** — verified to hold across
  all 139 runtime tags, and now enforced. Without it, tagging any commit
  `plugin-runtime-v<anything-higher>` discharged every outstanding obligation,
  because the digest at that tag was the debt's own tree.
- **A tag force-moved *within* one version's window still passes.** Nothing in
  a local clone can distinguish it from the original: git keeps no record of a
  tag's previous target. Closing this needs an anchor outside the repository —
  signed tags, or release SHAs recorded in the ADR-0049 evidence store — and
  that is a decision of its own, not a line in this checker.
- **A manifest advanced but never tagged sits in `release_in_flight`
  indefinitely.** No local signal separates "tag in six minutes" from "tag
  never", and §Alternatives C′ rejects thresholds on measurement. What bounds
  it in practice is that the release workflow is itself red when it fails to
  tag.

The post-tag assertion in `release-please.yml` needs `!cancelled()`, not a bare
condition. A step condition that names only its own predicate still carries an
implicit `success()`, so any earlier failure in that job would skip the
assertion — and because release-please reports `releases_created` exactly once,
the documented manual re-run then skips every gated step and goes green having
asserted nothing.

## Consequences

**Positive**

- The invariant checked is the one ADR-0051 §Decision 3 states — that released
  bytes match accepted bytes — rather than a proxy for it. It verifies the tag,
  not the author's choice of commit type.
- It reuses a three-part shape already working in this repository: a
  history-aware checker that fails closed, `fetch-depth: 0` on the workflow
  that runs it, and an inline re-run inside `release-please.yml` to cover the
  bot push. No new state model, no new artifact family, no schema to retain.
- It is immune to the two failure modes measured on the metadata gate: a PR
  title edited after CI passes, and a `BREAKING CHANGE:` footer in a body that
  routes differently than the title implies.
- Coalescing is free. Several protected changes before one release are
  satisfied by a tag carrying the final tree; no supersession rule is needed.

**Negative**

- **It detects; it does not prevent.** The offending merge lands and main turns
  red afterwards. With no branch protection on `main` this costs nothing
  relative to the alternatives — a PR-time check could not have blocked the
  merge either — but if branch protection is ever adopted, a PR-time gate would
  become strictly stronger and this decision should be revisited.
- Main is honestly red for the duration of every legitimate refresh window —
  measured median 5.3h. That redness is intended, and it is a second
  standing red alongside the proof-coupled one.

  **Measured against commits rather than against changes, the cost is larger
  than that median suggests, and the implementation measured it rather than
  inheriting the estimate.** Replaying the adopted check over the last 119
  first-parent `main` commits with the epoch set far enough back to put every
  commit in scope, **48 of them — 40.3% — classify as outstanding debt**, in 7
  contiguous windows of 0.0, 0.0, 0.6, 12.9, 25.9, 33.9 and 53.9 hours. The
  mean window, 18.2h, agrees with the 17.6h measured over all 38 baseline
  changes; the median does not, because a window's cost is paid per CI run, not
  per change, and the long windows contain the most commits. Three of the seven
  open with a `docs: align runtime docs to …` post-release recovery — the
  authoring form §Alternatives A was rejected for rejecting, here reappearing
  as the dominant source of redness rather than of rejection.

  This does not change the decision: with no branch protection, every candidate
  detects rather than prevents, and A's own measurement was worse. It does mean
  the operational claim to make is "main will be red a substantial fraction of
  the time until baseline refreshes routinely carry a bump-inducing type", not
  "main will be red for about five hours after a refresh".
- The check cannot prove *causation*. A later unrelated runtime release
  legitimately clears the debt because it ships the bytes — which is exactly
  what `plugin-runtime-v0.90.0` did for `16b1833`. The check measures how long
  accepted and released bytes disagreed, which is the harm; it does not
  certify that the baseline is why a release happened.
- Correctness depends on tags being immutable and history complete. Both are
  asserted rather than assumed, and both fail closed.

**Neutral**

- The baseline keeps its location, format, grammar and review path. ADR-0051
  §Decision 1–8 are untouched; this ADR only supplies the enforcement its
  §Out of scope deferred.
- `check-host-version-drift.mjs` keeps reading the repository copy — ADR-0051's
  explicit CI carve-out, unchanged.

## Alternatives Considered

### The nine-axis comparison

Uniform weights; **essence** and **foundation** are the decisive axes, the
other seven supporting. `++` strong, `+` favourable, `~` neutral, `−` costly,
`−−` disqualifying on that axis.

| Axis | **C** adopted<br>history/tag | A<br>PR-time type | B<br>obligation ledger | C′<br>cron threshold | D<br>relocate asset |
|---|:--:|:--:|:--:|:--:|:--:|
| **essence** *(decisive)* | `++` verifies released bytes | `−` proves intent, not delivery | `++` proves the tag carries it | `+` same as C when it fires | `−−` solves a cost that measures 0.3% |
| **foundation** *(decisive)* | `++` derives truth from immutable history | `~` couples to squash-message discipline | `−` a real state machine to own forever | `~` correctness hinges on a tuned constant | `+` right on data-vs-code, wrong on §Decision 1 co-location |
| standards | `+` git tags + SemVer identity | `+` Conventional Commits | `+` content hashes, immutable records | `+` same as C | `+` content addressing |
| recommendation | `~` custom policy | `~` no standard says a title proves delivery | `~` release-please has no such lifecycle | `~` custom policy | `~` none |
| canonical-precedent | `++` `check-doc-evidence.mjs` + `fetch-depth: 0` + the inline re-run in `release-please.yml` — all three already exist | `~` no path-scoped title gate here | `−` none in repo | `+` `host-version-drift.yml` | `+` ADR-0050 create-and-repoint |
| extensibility | `+` grows to more packages via an owning-package map | `+` protected paths grow easily | `++` grows to SLA and debt dashboards | `+` same as C | `~` new family to extend |
| maintainability | `+` one checker, one test file, no state | `++` smallest possible | `−` schema, retention, evolution | `+` small, but the constant needs re-tuning | `−` artifact family + acceptance protocol + migration |
| maturation | `+` historical audit and time-to-release reporting come free | `~` cannot model outstanding debt | `++` richest model | `~` same limits as C plus the constant | `+` decouples data cadence entirely |
| practical-fit | `++` no branch protection ⇒ detection is all any option delivers | `−` rejects 63% of the authoring pattern; title race | `−` most machinery for a single-owner repo | `−` measured to miss the counterexample at 48h | `−` per-machine acceptance across a multi-machine owner |

The matrix is not close on the decisive pair. A loses **essence** because a
correctly-typed PR still permits an unreleased asset, which is the very state
`16b1833` produced. B wins essence but pays **foundation** in permanent state.
D loses essence outright: it is a well-formed answer to a cost that measurement
puts at 0.3%. C′ is C with a tuned constant that measurement shows mis-tunes.

### The options in detail

**A — release-routing type enforcement at PR time.** Require a protected-asset
PR to carry a bump-inducing conventional type, checked against the PR title
because that is what supplies the squash subject. Measured against the whole
history rather than argued: it correctly rejects `16b1833` and correctly
accepts `354a95d` and `20ebed7`, but it **rejects 24 of 38 historical baseline
changes — 63%.** Those are not stray mistakes; they are the project's dominant
authoring form (`docs(runtime): refresh host-parity baseline to …`). Rejected
on three grounds. It proves release *intent*, not that a release was tagged —
the counterexample's own PR could have been retyped and still left a 54h
window if no release followed. As it would naturally attach here it is
bypassable: every workflow uses a bare `pull_request:` trigger, whose default
activity types exclude `edited`, so a title can be changed to `docs:` after the
check goes green. And with no branch protection it cannot block a merge
regardless, so it buys the cost of a mandated two-PR loop without buying
prevention. Its residue is kept: the routing-type requirement stays a prose
rule in `AGENTS.md`, which is where it already effectively lives.

**B — tag-consumed obligation ledger.** An append-only record outside the
package marks each protected change and a later tag discharges it. It is the
most auditable option and it survives title edits and delayed releases. Rejected
on proportionality and on state-model cost: coalescing, supersession, in-flight
states and tag races form a real state machine with a schema and a retention
policy, and it deadlocks if a generic pending-obligation check also blocks the
release-please PR. It also cannot record its own future squash sha, so records
must bind tree identity and derive ancestry later — at which point it is
computing what the adopted check reads directly from history, with a ledger in
between. No release-please feature backs it; the integration is entirely custom.

**C′ — scheduled watchdog with a staleness threshold.** A variant of the
adopted approach, evaluated on a cron like `host-version-drift.yml` and failing
when an unpromoted window exceeds N hours. Prototyped and **rejected on
measurement.** Simulated against the real twice-daily cadence (181 firings), a
48h threshold **misses `16b1833` entirely**: the interval in which its window
exceeds 48h is only 6.0h wide (2026-08-10T07:33Z until the tag at 13:36Z) and
neither the 06:00Z nor the 18:00Z firing lands inside it. It catches the
counterexample only at ≤36h, where it flags 5 of 38 changes across 17 of 181
firings. The threshold is not an independent knob — it is coupled to the
schedule granularity, and a threshold near the observed window sizes degrades
to a coin flip. The adopted approach has no threshold and no cron, so the
coupling does not arise.

**F — content-identity lock in the `sync-companion-bundles.mjs` shape.**
Considered and rejected as ill-formed for this problem. That precedent works
because both copies live in the tree at once and can be compared byte for byte.
The divergence ADR-0051 fixed was between *installed host caches* and the
repository, which no in-tree comparison can observe. A version→content lock
checked at PR time collapses back into the premise §Context records as
disproved, because the version legitimately changes after the PR. The
content-identity family is only expressible at promotion time or post hoc —
which is the adopted approach.

**D — relocate the baseline to a content-addressed artifact outside the
package.** Deferred, per item 1, on measurement rather than on soundness. Its
strongest argument is not latency but architecture: data and code should not
share a version, and versioning an observation inside the runtime package means
every refresh manufactures a code release carrying no code change — which
ADR-0051 §Consequences already concedes and `0.90.1` concretely is. What defers
it is that the damage from that spurious release flows almost entirely through
a *separable* policy (item 6's proof coupling), not through packaging.

The design question ADR-0051 left open is answered here so the deferral is
honest rather than a dodge. §Decision 1 is shadow-proof because the resolver
derives `PLUGIN_ROOT` from `import.meta.url` — code and data ship co-located
and are found by the module's own path. D can re-establish that without
shipping a changing pointer: package a stable canonical locator and trust
anchor once (the upstream repository and the acceptance-record schema, not the
current hash); have an explicit command fetch an acceptance record from that
anchor, verify its source commit and content SHA-256, write immutable bytes to
a machine-global object store, and atomically repoint a single `accepted` ref;
have runtime commands read only that ref and object, never a cwd, a Git root,
or any consumer-repository path. A purely local record is insufficient unless
signed or verified against the anchor, or a dirty checkout could manufacture
acceptance. This is the create-and-repoint immutable-object pattern
[ADR-0050](0050-fragment-persistence-boundary.md) already establishes. It also
makes D's true cost explicit — it converts a packaging problem into a
distribution-and-trust problem, and relocates the divergence class from two
host caches on one machine to two machines, which this owner has.

**Baseline-only scope.** An earlier reading of this decision narrowed the
protected set to the baseline alone, on the measured ground that it is the only
verdict input ever changed by a non-routing commit — the others move exclusively
under `feat`/`fix` because they change only as part of code work. Cross-host
review disproved the reasoning: absence of a past violation is a base rate, not
a guarantee, and the fixed-version cache-divergence mechanism is identical for
bootstrap authority and the validation schemas. The narrowing was only ever
justified for the *cross-package* asset, which item 3 excludes on its own
grounds; within `plugins/runtime` the marginal cost of covering all three paths
is one pattern in an array. Recorded rather than removed, because the base-rate
error is the kind worth being able to re-recognize.

## References

- [ADR-0051](0051-host-parity-baseline-source.md) §Decision 2, §Decision 3,
  §Out of scope, §Alternatives D — the obligation, its asset scope, its
  unenforced status, and the alternative re-judged here.
- [ADR-0026](0026-runtime-compatibility-drift-and-release-notes.md) §3 — the
  two-branch resolution rule and the repository-review requirement, unchanged.
- [ADR-0016](0016-cross-package-commit-splitting.md) — release-please routing
  semantics, and why a cross-package asset needs an owning-package mapping.
- `scripts/check-host-version-drift.mjs` and
  `.github/workflows/host-version-drift.yml` — the scheduled tracking-issue
  detector whose shape this decision reuses, and the patch-tolerance policy
  that contradicts the runtime's.
- `scripts/sync-doc-versions.mjs:306` — the proof-coupled documentation gate
  that supplies ~23h of the measured 51.84h.
- `plugins/runtime/scripts/lib/host-parity-baseline.mjs` — the resolver whose
  `import.meta.url`-derived root is what makes ADR-0051 §Decision 1
  shadow-proof.
