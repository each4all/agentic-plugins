Ensemble dispatch and synthesis are recorded in **two complementary
locations**, both through {{persona}}'s `../../../../scripts/state.mjs`:

1. **Frontmatter** — programmatic bookkeeping via the `pending_ensemble`
   and `ensemble_results` schema fields. `ensemble-pending` records that
   a dispatch began (idempotent on `run_id`); `ensemble-commit` performs
   the atomic three-step mutation (pop matching pending → append result →
   prune to the retention cap). Command-managed ensembles normally let
   `peer-runner.mjs run --kind ensemble` record the pending row before
   spawning the companion, and settle it with `peer-runner.mjs settle`,
   which reads the run's ledger and records the review's outcome. A hand
   `ensemble-commit` reads no ledger: it refuses a review whose run has
   one, and closes the attempt of a review whose run has none `failed`
   (`verdict-only`) whatever its verdict (C163 A1a).
2. **Markdown body** — human-readable phase notes appended via
   `state.mjs append --phase-note-file ...`, the note a file written with
   the file-writing tool, never shell source (ADR-0059, amendment of
   2026-10-10):
   - in-flight marker: `### Ensemble launched: <type> at <iso-utc>`
   - synthesis result: `### Ensemble synthesis: <type> verdict=<...>`
     followed by the AGREED / LOCAL-ONLY / PEER-ONLY / CONFLICT breakdown

Frontmatter is the machine-parsable retrospective surface; the body is
the human-readable narrative. Both are written under the per-file lock
and MAY be written in separate calls.

**A conflict leaves a third record (ADR-0067 Decision 8).** When decide,
critique or investigate settles a run whose synthesis verdict is
`conflict`, the verb also writes the contested items, prepared as its peer
prompt was, to the workflow's consensus task file,
`<home>/consensus/<workflow-id>.<run-id>.md`
(`../../../../scripts/state.mjs consensus-task`, which refuses unless
`ensemble_results` holds the run with the verdict `conflict`), and its
conflict gate records that run id. `runtime:consensus plan --task-file`
reads the file when the owner runs the proposed round; once the gate leaves,
the file is renamed `<workflow-id>.<run-id>.resolved.md` and kept.

**Each attempt is settled from its run ledger.** A verb's finalize runs
`../../../../scripts/peer-runner.mjs settle` with the run id its dispatch
generated (empty when no run launched) before its last write, and the
ledger, not the agent, decides what the workflow records:

- never launched ({{skip_cause}}):
  no `ensemble_results` entry (a review's attempt only, below), and the
  phase note's first heading reads `### Ensemble skipped: …`;
- launched, then failed, cancelled or abandoned: an `ensemble_results`
  entry with verdict `failed` and the ledger's `error_kind` in its summary;
- completed: the synthesis verdict, or `degraded` when the answer was empty
  or unreadable (the synthesis is then local-only). An answer that parses to
  nothing usable, only structural shell, reads to `settle` like any other:
  the synthesis judges it, and its verdict is then `degraded`.

`settle` refuses while the run is still live (collect it first), and when an
empty run id would hide a run that launched for the same workflow and phase.

**A review attempt keeps one outcome (C163 A1a, ADR-0023 implementation
note of 2026-11-05).** For the review types (`review`, `adversarial-scan`,
`plan-verify`, `refine-verify`), the workflow's `review_attempts` scalar keeps
every attempt, outside the 20-row `ensemble_results` cap: the runner
registers it, open, in its pending row's write; settle closes it in its
result's write with one outcome (`passed`, `concerns`, `conflict`, `failed`,
`degraded`, `unavailable`, `malformed`, `skipped` with its reason, or
`superseded` with its replacement), the raw verdict, status and `error_kind`,
and the tree the peer's snapshot held. A review that never launched is
recorded too, with its reason (`unavailable` or `skipped`): the finalize's
`NO_RUN_REASON` gives it, as do the `/start` lifecycle's `--no-run-reason`
and, on Codex, the verb skill's own settle step. `state.mjs review-attempts` prints them; an open attempt, a review
result with no attempt and an unreadable document read `unknown`, never
`passed`, and the coverage says when the history is incomplete. This records
only: nothing reads an outcome to allow or refuse a step.

**`peer-now` is structurally excluded** from `ensemble_results`, by two
independent mechanisms:

1. `../../../../scripts/peer-runner.mjs` registers a `pending_ensemble` row
   only when `kind === 'ensemble'` — the `handle.kind !== 'ensemble'`
   early return. A `--kind peer-now` run cannot reach that write path.
2. The `peer-now` meta skill omits the three ensemble-accounting flags:
   `--workflow-path` / `--phase` / `--ensemble-type`. It **does** pass
   `--run-id`, which is the peer-run **ledger** key (it names the
   `peer-runs/<run_id>/` directory and lets `peer-runner.mjs status` /
   `cancel` address the run), not an ensemble key. Passing it is correct
   and does not create an ensemble record.

`ensemble_results` stays reserved for verb-skill structured ensemble
verdicts. A `[Peer]` label phase note in the workflow body is peer-now's
only trace in the workflow; the run's own ledger under
`peer-runs/<run_id>/` keeps its handle and logs.
