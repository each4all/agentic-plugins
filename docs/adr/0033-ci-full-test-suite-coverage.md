# ADR-0033: CI full-suite coverage via test discovery

## Status

Accepted

> Amended 2026-10-03 — see [Amendments](#amendments). Decision 3's
> triggers and Decision 5 (iii) changed, and Decision 4 is withdrawn: the
> host workflows are removed and CI no longer triggers on `pull_request`.
> Amended 2026-10-05: Decision 1's serial pin is removed; `npm test` runs at
> Node's default concurrency.
> Amended 2026-10-19: `full-tests.yml` runs `npm test`'s files as a matrix of
> shards that together run each file once, and Decision 5's guard pins the
> shards instead of one `npm test` step.

## Context

The repository's canonical test command is `npm test`. Yet **no CI
workflow ran it**. CI test execution was spread across hand-curated
lists:

- `claude-tests.yml` and `codex-tests.yml` each run their own
  companion's unit test plus `npm run test:plugin-shape` — a curated
  *subset* (plugin-shape + engineer + orchestrator + kit lint).
- `cross-host-tests.yml` runs `npm run test:cross-host` (3 files).
- `marketplace-validate.yml` runs the validate *scripts*, not the test
  files that assert their behavior.
- `host-version-drift.yml` runs `tests/scripts/test-check-host-version-drift.mjs`
  only when drift-related paths change (path-filtered).
- `release-please.yml` runs no tests.

Because the canonical full list (`npm test`) was run by nobody, any test
file not also wired into one of the curated lists was gated by **no
normal-PR CI**. At the time of this ADR that was 13 files:

- `companions/tests/contract-parity.test.mjs`
- all 9 `tests/runtime/*.mjs` (doctor, settings, consensus, worktree,
  context, compat, footer, cutover-audit, migrate-workflow-storage)
- `tests/scripts/test-sync-marketplace.mjs`
- `tests/scripts/test-validate-artifacts.mjs`

plus `tests/scripts/test-check-host-version-drift.mjs` covered only
partially (path-filtered).

**Root cause.** CI coverage depended on hand-curated enumeration in two
places (the `test:plugin-shape` npm script and per-workflow
`node --test <file>` steps), while `npm test` — the one list meant to be
authoritative — was executed by nothing. A test added to `npm test`
silently dropped out of CI unless someone *also* remembered to wire it
into a curated list. A deeper latent fragility: `npm test` was itself a
hand-maintained explicit file list, so even it could drift.

This decision was reached through an `engineer:start` lifecycle with a
9-axis decision matrix (ADR-0027) and two opposite-host Codex peer
ensembles (brainstorm + plan-verify). The plan-verify peer caught a
release-breaking defect in an earlier draft (see Consequences →
release-please).

## Decision

Adopt **discovery-based testing with an unfiltered full-suite gate and a
structural guard** (the "E′" option):

1. **`npm test` is `node --test --test-concurrency=1`** (no-arg
   discovery, serial). Node 24 recursively discovers test files by its
   default conventions — extensions `{js,cjs,mjs,ts,cts,mts}` (Node 24
   strips types, so TypeScript files are discovered too) with stems
   `*.test`, `*-test`, `*_test`, `test-*`, or `test`, plus any such file
   inside a directory named `test` — skipping `node_modules` and hidden
   (dot-prefixed) directories. The
   previous explicit ~61-file list is removed. Adding a
   conventionally-named test file is now a single action — create the
   file; CI runs it automatically. Execution is serial
   (`--test-concurrency=1`) to match the existing
   `test:plugin-shape` precedent: several suites spawn `node`
   subprocesses with timeouts, and concurrent execution caused
   load-dependent flakes whose likelihood varied with the runner's CPU
   count (Node's default concurrency). Serial execution is deterministic
   and, because the suite is largely subprocess/I-O-bound, costs no wall
   time (~203s serial vs ~214s concurrent locally). (2026-10-05: the
   serial pin is removed, and `npm test` is `node --test
   --test-timeout=120000` — see [Amendments](#amendments).)

2. **Smoke tests move out of the discovery namespace.** The host-CLI
   smoke tests are renamed `companions/tests/*.smoke.test.mjs` →
   `companions/tests/*.smoke.mjs`. CI runners have no `claude`/`codex`
   CLI, so smoke tests must be explicitly opt-in via
   `npm run test:smoke` (which names the files directly), not silently
   present as skipped tests in every discovery run. The
   `{ skip: !COMPANIONS_SMOKE }` guard remains as defense-in-depth, but
   the naming boundary is what keeps them out of `npm test`.

3. **New `.github/workflows/full-tests.yml`** runs `npm test` with **no
   `paths:` filter** on `pull_request`, `push: main`, and
   `workflow_dispatch` (2026-10-03: on a push to any branch and
   `workflow_dispatch` instead — see [Amendments](#amendments)). This is
   the repo-level coverage authority. It replicates the host workflows'
   `AGENTIC_RELEASE_PLEASE_PR` branch detection so release-please PRs
   tolerate intentional version/catalog lag. (2026-10-19: it runs
   `npm test`'s files as a matrix of shards, each file once — see
   [Amendments](#amendments).)

4. **Host workflows remain scoped diagnostic signals.** *(Withdrawn
   2026-10-03: the host workflows are removed — see
   [Amendments](#amendments).)* `claude-tests`, `codex-tests`, and
   `cross-host-tests` keep their deliberate host-segregation (each
   scoped to its own companion's tests); they are
   no longer the coverage authority. The redundant `test:plugin-shape`
   they share is retained as a fast per-host signal and is out of scope
   for this ADR.

5. **New guard meta-test** `tests/scripts/test-full-suite-coverage.mjs`
   (itself discovered) enforces the invariants so they cannot silently
   regress: (i) every file Node's discovery would pick up lives under
   one of the three roots (`companions/tests`, `tests`,
   `kit/lint/tests`) — scanning the filesystem and mirroring Node's
   discovery semantics, not a fixed file count; (ii) smoke tests use the
   non-discoverable `*.smoke.mjs` namespace and no `*.smoke.test.mjs`
   remains; (iii) `full-tests.yml` exists, gates `pull_request` without a
   `paths` filter, runs exactly `npm test`, and wires the release-please
   env. (2026-10-03: (iii) now asserts the push trigger, and the guard
   gains (iv) and (v) — see [Amendments](#amendments). 2026-10-19: (i) and
   (ii) read the discovery the shards split instead of mirroring it, and
   (iii) and (v) pin the shards — see the amendment of that date.)

## Consequences

**Positive**

- Every test file is gated by CI on every push/PR. The 13 previously
  uncovered files now run; a passing CI means the full suite passed.
- Adding a test is one action; the coverage gap cannot silently
  re-open. The guard turns any future drift (a stray test outside the
  roots, smoke re-entering the namespace, the workflow being removed or
  path-filtered) into a loud CI failure.
- `npm test` now uses Node's standard discovery instead of a
  hand-maintained list.
- Bringing the full suite under CI immediately surfaced a latent
  concurrency-sensitive test (`tests/orchestrator/test-discover-engineer.mjs`
  timed out spawning a subprocess under concurrent load) that passed
  serially via `test:plugin-shape` but had never run concurrently in CI —
  exactly the kind of gap this gate exists to catch. The serial pin fixes
  it for good. (2026-10-05: the pin is removed — see
  [Amendments](#amendments).)

**Negative**

- `full-tests.yml` re-runs work the host/cross-host workflows also run
  (~214s suite). De-duplicating that redundancy is a deliberate
  non-goal here (it would disturb the host-segregation design); it can
  be a separate follow-up.
- The release-please env must stay mirrored in `full-tests.yml`; the
  guard asserts its presence to prevent silent removal.

**Neutral**

- Smoke test file paths changed; `npm run test:smoke` and the
  `COMPANIONS_SMOKE` env are unchanged. Historical audit evidence under
  `docs/audits/` intentionally retains the old `*.smoke.test.mjs`
  command strings as a point-in-time record and is not rewritten.
- **Operational follow-up (out-of-repo):** "full-tests is the
  authority" is only enforced once the `full-tests` check is marked
  *required* in branch protection. This ADR ships the workflow; making
  it a required check is a repo-settings action taken after its first
  run names the check.

## Alternatives Considered

- **A — Additive full-suite job only.** Add `full-tests.yml` running the
  *existing explicit-list* `npm test`; no guard, no smoke change. Closes
  the manifested gap but leaves the latent list-drift mechanism intact
  (a new test still must be hand-added to the list). Rejected: weaker on
  the decisive *essence*/*foundation* axes — it guards nothing.

- **A+D — Explicit list + guard.** Keep the explicit `npm test` list and
  add a guard asserting every disk test file is enumerated in it.
  Drift-proof, but adding a test stays a two-action chore (create file +
  edit list, or hit a fail-then-fix loop) and retains a redundant list
  artifact. Rejected in favor of E′: discovery removes the list entirely
  and is the Node-standard pattern, so E′ scores higher on
  *standards*/*essence* while keeping the same guard guarantees.

- **B — Gap-only curated job.** Add `test:runtime` + `test:scripts`
  curated scripts and a workflow running just the gap files. Rejected:
  recreates the exact hand-curated-list fragility that is the root
  cause.

- **C — Consolidate host workflows into `npm test`.** Replace the
  per-host curated steps with the full suite and de-duplicate. Rejected:
  most invasive, and running the full suite inside both host workflows
  blurs the deliberate host-segregation and doubles the slowest work
  (the brainstorm peer flagged this explicitly).

A 9-axis evaluation (ADR-0027 `nine-axis` preset; decisive axes
*essence* and *foundation*) placed E′ ahead on 8 of 9 axes, trailing A
only on diff size (*practical-fit*), which the project's quality values
(`best-results-over-token-minimization`) treat as non-decisive.

## Amendments

### 2026-10-03 — host workflows removed, CI triggers on push to any branch

**Trigger**: macro subtask A1 (owner request 2026-10-03: CI, test and
release machinery reduced to what earns its keep). This is the
de-duplication follow-up the Negative consequences above deferred.

**What changed.**

- `claude-tests.yml`, `codex-tests.yml` and `cross-host-tests.yml` are
  deleted, so Decision 4 is withdrawn. Every test file they ran was
  already discovered by `npm test`. Their two non-test steps were also
  duplicated: the companion-bundle drift check is
  `tests/plugin-shape/test-companions-plugin.mjs`'s byte-identical check
  for all three bundled scripts, and `node --check` is subsumed by the
  companion unit tests, which import the module. Alternative C's
  objection does not apply: the suite is not run inside both host
  workflows; it runs once.
- `marketplace-validate.yml` is replaced by `validate.yml`, which runs
  the checks that are not test files: `npm run lint:plugin-shape` (kit/lint
  over every plugin; the kit/lint tests lint only two real plugins) and
  the catalog, version and artifact validators. It has no path filter.
- The curated `test:plugin-shape` and `test:cross-host` npm scripts are
  removed. Only the host workflows ran them, and an unenforced curated
  list is this ADR's root cause. A local subset runs as
  `npm test -- <files>`.
- **Decision 3's triggers.** `full-tests.yml` and `validate.yml` run on
  `push` to every branch (`branches: ['**']`, which keeps tags out) and
  on `workflow_dispatch`. Neither has a `pull_request` trigger. The
  reason is a GitHub rule: when a workflow creates or updates a pull
  request with `GITHUB_TOKEN`, the resulting `pull_request` runs
  are created in an approval-required state. release-please uses
  `GITHUB_TOKEN`, and from 2026-07-20 every release-PR update started
  five such runs. Unapproved, each sat with zero jobs and concluded
  `failure` when the PR closed: 244 `failure` and 50
  `action_required` runs. The last approval was on 2026-08-12, so the
  release PR's CI had not run since. A push made with `GITHUB_TOKEN`
  starts no run at all. A pull request shows the checks of its head
  commit's push run. A branch deletion, which GitHub runs as a push on
  the default branch's sha, is skipped by a job-level condition.
- `AGENTIC_RELEASE_PLEASE_PR` is read from `github.ref`, since
  `github.head_ref` is empty on a push. release-please's own pushes
  start no run there; a person's push or a manual dispatch on that
  branch does.
- **Decision 5 (iii).** The guard asserts that `full-tests.yml` runs one
  `npm test` with no matrix and the push-event env form. Two
  invariants are added: (iv) every workflow but `release-please.yml`
  has exactly the push-to-any-branch and dispatch trigger; (v) no
  workflow but `full-tests.yml` runs tests.

**Accepted costs** (owner decision 2026-10-03, option A over a GitHub App
token for release-please):

- Fork pull requests get no CI. None of the repository's first 844 pull
  requests came from a fork.
- A run tests the branch head, not the pull request's merge with its
  base. Main's later changes are tested by the push that lands the
  branch.
- The release PR gets no CI before merge. It had none in practice since
  2026-08-12. The post-sync dispatch still validates `main` after the
  release.
- A push event names no target branch, so the pre-merge monotonic-pin
  baseline is the branch's fork point on `main`. The comparison against
  `main`'s newer catalog happens on the push that lands the change
  (ADR-0061 Decision 2, note of the same date).
- A pull request that targets another branch is still compared against
  `main`.

**Transition and rollback.** A branch cut before this change keeps the
old workflow files: its pushes start nothing, and with no
`pull_request` trigger left, it gets no automatic CI until it is
rebased onto `main` or merges it. A manual dispatch of `full-tests`
on that branch still runs, since the old file accepts
`workflow_dispatch`. Going back to pull-request testing is not a one-line change.
Adding `pull_request` alongside the push trigger would start two runs
per update of a same-repository pull request. A rollback has to change
the triggers of both workflows, the env expression, the baseline
selection in `validate.yml` and this guard together. It also needs a
GitHub App token for release-please if the release PR is to get CI.

> **Amended 2026-10-04 by [ADR-0065](0065-release-ceremony-reduction.md).** The
> branch-keyed allowance (`AGENTIC_RELEASE_PLEASE_PR`, Decision 3) is replaced
> by one keyed on content: only a commit that itself changes a package's
> version in `.release-please-manifest.json` may see the catalogs trail that
> change (ADR-0065 Decision 8). Decision 5 (iii) no longer asserts the
> release-please env wiring, which is gone. The accepted cost "The post-sync
> dispatch still validates `main` after the release" no longer holds. The
> dispatch is removed; the release commit's own run is green, and the release
> job validates the catalogs before it pushes the sync.

### 2026-10-05 — `npm test` runs at Node's default concurrency

**Trigger**: macro subtask CC, from the owner's selection of 2026-10-05 at
E1 (engineer workflow `decide-20261005T015832Z-7931cf`, item 7), which
reviewed what the 2026-10-03 reduction left in place.

**What changed.** `npm test` is `node --test --test-timeout=120000`. The
`--test-concurrency=1` pin is gone, so Node runs up to
`os.availableParallelism() - 1` test files at once (at least one), its
default. The
per-test timeout that bounds a hung test
(`tests/scripts/test-test-timeout-policy.mjs`) is unchanged.

**Why.** Decision 1 rested on two claims: running files concurrently
caused load-dependent flakes, and running them serially cost no wall time
(~203 s against ~214 s). The pin came from the `test:plugin-shape` script
(2026-05-15) and was carried into `npm test` by this ADR. The second claim
no longer holds. E1 timed one tree both ways, with `AGENTIC_*` removed from
the environment: 561 s serially against 112 s at default concurrency
(9 workers on a 10-core Mac). Both runs counted 6,688 tests: 6,687 passed,
1 was skipped, none failed. On CI the full-tests workflow runs just before
this change, still serial, took 310–392 s from start to finish.

**What the measurement does not show.** Both timings come from one
machine. GitHub's runners have fewer cores, so fewer workers, and their
timing differs. The tests most exposed are bounded races, such as the
post-link re-check case in `tests/runtime/test-bootstrap.mjs`, which retries
40 times to reach a window whose hit rate was measured under one load. So
the change lands only after a burn-in: the full-tests run of the branch push
and two `workflow_dispatch` runs on the branch must all pass, with the same
test counts, before the pull request merges. If any of them flakes, the pin
stays and the flake is recorded instead.

**Unchanged.** `scripts/mutation-harness.mjs` still runs each mutation's
tests with `--test-concurrency=1`. It runs only a spec's own few test files,
and a flake there would score a mutation wrongly, so it keeps determinism
over wall time.

**Rollback.** Put `--test-concurrency=1` back into `scripts.test` in
`package.json`. No other file sets or checks the suite's concurrency.

### 2026-10-19 — the suite runs as shards

**Trigger**: macro subtask `ci-shard` of macro 5 (owner decision of
2026-10-19, docket C152). The one full-tests job took 24 m 32 s to 24 m 54 s
on recent green runs, against the 25-minute bound of its test step (the job's
was 30). PR #978's first attempt ran the suite in 1,015 s; two reruns hit the
step bound and failed with no test failing. The slowest files were the
runbook region contracts (316 s), the landing reports with lanes (144, 98 and
65 s) and the verb runbook blocks (112, 99 and 57 s).

**What changed.**

- **Decision 3.** `full-tests.yml` has two jobs. `shard` is a matrix over
  one axis, `shard: [1, 2, 3]`, with `fail-fast: false`; each shard checks
  out the full history, sets up Node 24 and runs
  `node scripts/shard-tests.mjs run "$SHARD/$TOTAL"`, where `SHARD` is
  `matrix.shard` and `TOTAL` is `strategy.job-total`, the matrix's own
  length. `full-suite`, named `full test suite (Node 24)` like the single job
  before it, needs `shard`, runs under `always()` and passes only when
  `needs.shard.result` is `success`, so the check that branch protection may
  require stays one check under its old name, and a failed or cancelled shard
  turns it red rather than skipped. `full-tests.yml` stays the only workflow
  that runs tests, and the coverage authority.
- **The split.** `scripts/shard-tests.mjs` takes Node's no-argument
  discovery (`scripts/lib/discover-tests.mjs`: Node 24's default pattern
  through `fs.globSync`, the glob Node's runner uses, with its `node_modules`
  exclusion). It weighs each file by its recorded seconds in
  `scripts/data/test-weights.json` plus 0.5 s for the process start and
  preload the recording leaves out, or 5 s when a file has no recording, and
  places files heaviest first into the least-loaded shard (ties by path, then
  lowest index), so every shard of a run computes the same partition. Before
  running, it checks the whole partition: every discovered file in exactly
  one shard, no shard empty, every path made only of letters, digits, `.`,
  `_`, `-` and `/`. Anything else stops the shard, naming the files. A new
  test file lands in a shard by being created; no list is kept.
- **The launch.** The shard prints its files, checks that each exists
  (`node --test` given a name that matches nothing runs the rest and exits 0)
  and that `package.json` has no `pretest` hook that could change them after
  the check, and starts `npm test -- <files>` with an argument array. The
  hermetic preload and the per-test timeout are therefore `npm test`'s own.
  npm runs the script through `sh`; the path rule keeps each name one word
  there, with nothing to expand. The shard removes any inherited
  `NODE_TEST_*` variable from npm's environment: a `node --test` that
  inherits `NODE_TEST_CONTEXT` takes itself for a child, runs nothing and
  exits 0.
- **The weights.** `scripts/lib/duration-reporter.mjs` is a `node:test`
  reporter that writes each file's duration (its `test:summary`, or for a
  file that never imports `node:test`, the file-level test Node reports in
  its place); `shard-tests.mjs record --from <file>` rewrites the weights
  from one full run and refuses a run that did not finish, did not pass, or
  missed a discovered file.
  Weights only balance the shards: a stale or missing one costs time, never
  coverage. `shard-tests.mjs plan` prints the estimated load per shard.
- **Decision 5.** (i) and (ii) read `discover-tests.mjs` instead of a
  hand-written mirror of Node's rules, and
  `tests/scripts/test-discover-tests.mjs` holds that list to a real
  `node --test` run over a fixture tree. (iii) pins the jobs of
  `full-tests.yml` line for line (comments aside), takes the shard count from
  the matrix (two to four, numbered 1..N), and checks that those shards run
  every discovered file exactly once; this replaces the 2026-10-03 form, one
  `npm test` with no matrix. (iv) allows the aggregate job's
  `always() && !github.event.deleted` condition in `full-tests.yml` only.
  (v) counts a step that calls `shard-tests.mjs` as a test runner, and the
  one runner left is the shard step.
- `scripts/mutation-specs/full-tests-shards.mjs` breaks the discovery, the
  partition, the launch, the wiring and the weights' validation one at a
  time, and names the test that must catch each.

**Why this split.** Node's own `--test-shard=i/N` assigns files round-robin
by position, blind to how long they run, and the suite's cost is
concentrated in a few files. A list of files per shard kept by hand is the
curated list this ADR removed. The partition check, not the balancing, is
what keeps coverage: the weights can be wrong without dropping a file.

**What the measurement does not show.** The weights were recorded on one
local run of the finished tree (a 10-core Mac, Node 24.11.1 at default
concurrency, 244 files, 11,936 tests: 11,751 passed, 185 skipped, none
failed, 1,230 s from start to finish), not on GitHub's 4-core runners, and a
file's duration under concurrency depends on what else runs beside it: the
recorded file times add up to 7,075 s, nearly six times the run's wall time.
A shard's weight is therefore a share of the suite, not a prediction of its
time. Three shards each hold about a third of the weight (2,399 s), and the
heaviest file (`tests/persona-pipeline/test-verb-runbook-runs.mjs`, 763 s)
is under a third of one, so a fourth shard would not be held up by it either;
three was chosen as the smallest count that leaves each shard well inside a
bound the single job filled. The bounds (step 20 minutes, job 25) are hang
bounds, set from the single job's 25 minutes rather than from the weights.
Whether three shards finish well inside them, and whether the required check
in branch protection is `full test suite (Node 24)`, is established by the
first real push, not here: its shards' printed lists must together equal
discovery at that commit, each file once.

**Rollback.** Revert the commit: the workflow, the scripts, the weights, the
guards and the mutation spec go back together. The restored single job
meets the 25-minute step bound again, so a rollback that has to hold should
also raise that bound.

### 2026-10-31 — four shards, weights recorded again

**Trigger**: PR #1010 (macro 5 subtask `verify-exec`). Its shard 2 of 3 hit
the 20-minute step bound with no test failing, still running persona
runbook files. The other two took 10 and 19 minutes. On PR #1008 a day
earlier the three shards took 12, 16 and 18 m 45 s. The weights had not been
recorded since 2026-10-19, and the suite had grown from 244 to 297 files.

**What changed.**

- `full-tests.yml` runs `shard: [1, 2, 3, 4]`; nothing else in the workflow
  changes. The bounds (step 20 minutes, job 25) stay hang bounds.
- `scripts/data/test-weights.json` was recorded again with
  `shard-tests.mjs record`, from one local run of this tree (a 10-core Mac,
  Node 24.11.1 at default concurrency, 297 files, 13,669 tests: 13,478
  passed, 191 skipped, none failed, 1,895 s from start to finish). The
  recorded file times add up to 12,458 s; four shards each hold about 3,152
  s of weight, and the heaviest file
  (`tests/persona-pipeline/test-verb-runbook-runs.mjs`, 961 s) is under a
  quarter of the suite.
- `scripts/mutation-specs/full-tests-shards.mjs` W6 and W7 anchor on the new
  matrix line and keep their defects (one shard never started; the shards
  not 1..N).

**Why four, not refreshed weights alone.** Balanced at three, the shards of
the October 30 runs would have taken about 17 minutes each, three minutes
inside the step bound, with the suite still growing. A fourth shard costs one
more runner per push and keeps each well inside it. Raising the bound
instead would keep the wall time and hide a hang for longer.

**What the measurement does not show.** As on 2026-10-19, the weights are
shares from one Mac run, not predictions of a 4-core runner's time. A file
added after this recording gets the fixed estimate until the next
recording; record again when the shards drift apart.

**Rollback.** Revert the commit: the matrix, the weights and the two
mutation anchors go back together.
