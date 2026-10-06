Ensemble dispatch and synthesis are recorded in **two complementary
locations**, both through {{persona}}'s `../../../../scripts/state.mjs`:

1. **Frontmatter** — programmatic bookkeeping via the `pending_ensemble`
   and `ensemble_results` schema fields. `ensemble-pending` records that
   a dispatch began (idempotent on `run_id`); `ensemble-commit` performs
   the atomic three-step mutation (pop matching pending → append result →
   prune to the retention cap). Command-managed ensembles normally let
   `peer-runner.mjs run --kind ensemble` record the pending row before
   spawning the companion.
2. **Markdown body** — human-readable phase notes appended via
   `state.mjs append --phase-note ...`:
   - in-flight marker: `### Ensemble launched: <type> at <iso-utc>`
   - synthesis result: `### Ensemble synthesis: <type> verdict=<...>`
     followed by the AGREED / LOCAL-ONLY / PEER-ONLY / CONFLICT breakdown

Frontmatter is the machine-parsable retrospective surface; the body is
the human-readable narrative. Both are written under the per-file lock
and MAY be written in separate calls.

**Each attempt is settled from its run ledger.** A verb's finalize runs
`../../../../scripts/peer-runner.mjs settle` with the run id its dispatch
generated (empty when no run launched) before its last write, and the
ledger, not the agent, decides what the workflow records:

- never launched (no dispatch ran: the privacy gate kept the verb
  local-only): nothing, and the phase note's first heading reads
  `### Ensemble skipped: …`;
- launched, then failed, cancelled or abandoned: an `ensemble_results`
  entry with verdict `failed` and the ledger's `error_kind` in its summary;
- completed: the synthesis verdict, or `degraded` when the answer was empty
  or unreadable (the synthesis is then local-only). An answer that parses to
  nothing usable, only structural shell, reads to `settle` like any other:
  the synthesis judges it, and its verdict is then `degraded`.

`settle` refuses while the run is still live (collect it first), and when an
empty run id would hide a run that launched for the same workflow and phase.

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
