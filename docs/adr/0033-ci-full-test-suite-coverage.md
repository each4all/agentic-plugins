# ADR-0033: CI full-suite coverage via test discovery

## Status

Accepted

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
   time (~203s serial vs ~214s concurrent locally).

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
   `workflow_dispatch`. This is the repo-level coverage authority. It
   replicates the host workflows' `AGENTIC_RELEASE_PLEASE_PR` branch
   detection so release-please PRs tolerate intentional version/catalog
   lag.

4. **Host workflows remain scoped diagnostic signals.** `claude-tests`,
   `codex-tests`, and `cross-host-tests` keep their deliberate
   host-segregation (each scoped to its own companion's tests); they are
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
   env.

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
  it for good.

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
