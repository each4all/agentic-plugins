# Runtime:consensus dogfood — 2026-05-29

ADR-0024 runtime/operator dogfood iteration (additional evidence; not a condition-3 transition per ADR-0012 immutable-rubric clause).

## Run identification

- **Run ID**: `consensus-20260529T123635Z-8722ee`
- **Run pointer**: `.agentic-plugins/runs/consensus/consensus-20260529T123635Z-8722ee/`
- **Date (UTC)**: 2026-05-29
- **Branch**: `docs/runtime-consensus-dogfood-2026-05-29`
- **Runtime version**: `plugin-runtime` v0.60.0
- **Driver workflow**: engineer cascade `investigate → decide → compose → critique → refine → execute` (workflow file at `.agentic-plugins/state/engineer/workflows/investigate-20260528T000350Z-4382d3.md`)

## Conflict candidate (framed in T1b)

**Operator UX shape for `owner-decision-required` after exhausted rebuttal rounds.**

The implementation correctly stores owner decisions as pointer-only artifacts (settled per ADR-0024), but the operator-facing experience at the `owner-decision-required` boundary is the least-developed branch in the status guidance code path. Three candidate policies were framed:

- **P1**: enrich `runtime:consensus status` output with structured `owner_decision_briefing` (durable disagreements + evidence pointers + decide command + template hint)
- **P2**: add new `runtime:consensus draft-decision` subcommand that scaffolds `owner-decision.draft.md`
- **P3**: documentation-only guidance in `SKILL.md` and command help

Frame written to `.agentic-plugins/runs/scratch/2026-05-29/frame.md` and consumed into the run's `task.md` via `--task-file`.

Real-openness verified via T1a evidence scan (`grep -rEn '(owner-decision-required|rebuttal|2 rounds|exhausted)' docs/adr/ AGENTS.md plugins/runtime/`): the policy exists for retention/recording but the operator UX shape is genuinely an active design surface per `AGENTS.md:333`.

## Peer roster + roles

| Peer | Lane | Role | Direction |
|---|---|---|---|
| claude | `companion_execute` | `claude_companion_peer` | codex → claude |
| codex | `companion_execute` | `codex_companion_peer` | claude → codex |

No manual lanes used. `max_rounds=2` (default), hard cap 3, exhaustion behavior `owner-decision-required`.

## Convergence outcome

**`convergence_state = aligned`** after round 1. Both peers independently recommended the same direction: **P4 hybrid — adopt P1 as canonical UX, supplement with P3 documentation, reject (defer) P2**.

Per the converged-terminates-without-decide rule (consensus.mjs:333-336 refuses `decide` for converged states), the run terminates at `consensus.json`. No round 2 needed. No `owner-decision.md` written.

Common reasoning across both peer outputs:
- `consensusArtifact.durable_disagreements` is already computed in memory at the guidance build site (`plugins/runtime/scripts/consensus.mjs:1848`); P1 exposes existing data, not new computation.
- Current `owner_decision_required` branch (`consensus.mjs:1891-1901`) emits only a bare `decide` placeholder — objectively the least-developed exit branch.
- ADR-0010 §6 high-cohesion trigger does not justify a new subcommand (P2); the "let operator see disagreements" affordance cohesively belongs in `status`.
- `AGENTS.md:333` explicitly names "context/footer integration" — folding into existing surfaces, not new ones.
- P1 is host-symmetric (same code on both hosts); P3-only is weakest in Codex per `[features].plugin_hooks` discovery asymmetry.

Common assumption flagged for verification before implementation:
- `durable_disagreements.summary` is assumed to be synthesized metadata, not raw peer output. If verification finds raw output, P1 must degrade to pointer-only briefing.

## Friction surfaced (dogfood value)

**T3b round 1 execute timed out on default `execution_timeout_ms=120000` (2 min) for BOTH peers** (peer raw output files were 0 bytes after initial run). The `execution_remediation` machinery correctly classified the failures as `retryable_failure` of type `timeout` and emitted per-peer retry commands with `--timeout-ms 240000 --process-budget 1` (single-peer at a time).

Both retries with the elevated timeout succeeded:
- claude peer: 7035 bytes (single-peer retry with 240s timeout)
- codex peer: 2378 bytes (single-peer retry with 240s timeout)

The friction is mild — remediation guidance worked exactly as designed (this is the surface that commit `dba7e1a feat(runtime): report consensus round output completeness` was added to handle). One observation worth recording: a 2-min default may be too tight when both companion peers run concurrently within `process_budget=2`; raising the default to 180s OR auto-staging to single-peer fallback after one timeout could reduce operator friction on the happy path. This is a candidate follow-up but NOT a blocker.

**Secondary friction (pre-existing, not introduced by this dogfood)**: `npm run validate:artifacts` reports a failure because the user's local `.git/info/exclude` line 10 has an overbroad `.agentic-plugins` rule, AND `.agentic-plugins/config.toml` does not exist in the working tree. The validate script (`scripts/validate-artifacts.mjs:64,100`) requires `.agentic-plugins/config.toml` to stay trackable so intentional repo-local runtime defaults remain visible. This is a local environment cleanup item (edit `.git/info/exclude` to narrow the rule, then ensure `.agentic-plugins/config.toml` exists), not something this PR introduces.

## Deliberate v4-plan deviation

The v4 plan T3a specified running all three doctor probes (`--sandbox-permission-probe`, `--permission-proof --execute-permission-proof`, `--deep-peer-smoke --execute-deep-peer-smoke`). The operator ran ONLY the read-only probes (`--sandbox-permission-probe` returned `read_only_probe_passed`; `--permission-proof` plan-only returned `ready_with_warnings`) and SKIPPED the `--execute-*` probes because T3b's `execute --execute` is itself the live proof of peer permission/sandbox readiness. This avoids doubling peer dispatch cost. Trade-off accepted: if T3b had failed on a permission/sandbox class (not timeout), additional preflight time would have been needed; in this case the live execute path produced the same readiness evidence in fewer peer calls.

## Artifact pointers + hashes

All artifacts are under `.agentic-plugins/runs/consensus/consensus-20260529T123635Z-8722ee/` (gitignored). The hashes below are the reproducible reference for cross-session verification.

| Artifact | Bytes | sha256 |
|---|---|---|
| `manifest.json` | 9211 | `cb223c62228b12752d3eea6d43b3758906f75424bc9fc614aa863613b07cb051` |
| `task.md` | 4335 | `288d9eb09fef4abae7b80b6136d0f9d4a2bedec523ad21cf0cbd2d59dfc77e40` |
| `execution.json` | 3921 | `42538f69efeab86ab412dd3ac9ec103e0b36f04507ee4a55757ebdb5bf98ba9f` |
| `execution-progress.json` | 2151 | `711abb3376fbbda2ec37ffc25dc3ea2311ba5992e14d26dd79a111012094d8ae` |
| `consensus.json` | 6587 | `4653edf46864894223f832c80db54899ebbc16472fc19bd5b90dba44d6c081fb` |
| `summary-r1.md` | 4609 | `26393615642c50e76bb08eba400452fb0e647c5ec226ce8b4a9b86e56e124efa` |
| `disagreements-r1.json` | 3 | `37517e5f3dc66819f61f5a7bb8ace1921282415f10551d2defa5c3eb0985b570` |
| `rounds/round-1/prompts/claude.md` | 5484 | `c6e79243e7760823f31669edeb02de53cb05dbd7ea614df950e3ae4d520fd789` |
| `rounds/round-1/prompts/codex.md` | 5482 | `eb34d9ef6882cffb4e901ac0b18a45d4c15bfa561372e7bcd8a8a9a4a8ff74d8` |
| `rounds/round-1/raw/claude.txt` | 7035 | `3d62d01ef4beb13ce8bfdb2f6fe67fbb581598287261e49b3903954d9a189e0c` |
| `rounds/round-1/raw/codex.txt` | 2378 | `eaa13f1dea8ed57af3454d122f7dbd57179bb157bf65eebb7a5e5bd41bd24b2b` |

## Recommended follow-up (out-of-scope for this dogfood)

The aligned consensus recommends a follow-up implementation PR (separate `/engineer:start` cycle) implementing P4 hybrid:

1. Modify `guidance()` in `plugins/runtime/scripts/consensus.mjs` to add structured `owner_decision_briefing` to the `owner_decision_required` branch (`:1891-1901`)
2. Modify `--format text` status output to render the briefing inline
3. Add `plugins/runtime/skills/consensus/SKILL.md` section: drafting template for owner-decision.md
4. Add tests pinning the briefing JSON schema + verifying no raw output leaks (the load-bearing invariant from the shared peer assumption)
5. Verify the shared assumption first: confirm `durable_disagreements.summary` is synthesized metadata via a focused investigate pass before composing

Candidate ancillary follow-up surfaced by the friction:
- Consider raising default `execution_timeout_ms` from 120s → 180s, OR auto-staging single-peer fallback after one timeout (not a blocker; small UX improvement)

## ADR-0012 framing

This dogfood is **additional evidence** for ADR-0012 condition 3 (engineer-only sufficiency for Stage 3+ development). The full engineer cascade (`investigate → decide → compose → critique → refine`) drove the dogfood without `omcc-dev:*` invocations; the runtime consensus surface itself produced the artifact evidence. Per ADR-0012's immutable-rubric clause, condition 3 status transition is determined by accumulated evidence in `docs/DEVELOPMENT.md:391`, not by this single run.
