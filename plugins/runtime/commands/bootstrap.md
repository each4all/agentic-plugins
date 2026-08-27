---
description: Machine-scoped, artifact-only bootstrap lifecycle — probe both hosts, plan a bundle install, render Stage 1-8 fragments and presented commands, resume with re-probe + proof recording, verify recorded evidence, and export/seed portable machine profiles
argument-hint: "plan [--bundle <id>] [--plugins <csv>] [--profile-file <path>] [--answers <path>] [--format text|json] | status [--run-id <id> | --latest | --latest-open] [--format text|json] | resume [--run-id <id> | --latest-open] [--answers <path>] [--format text|json] | verify [--run-id <id> | --latest] [--format text|json] | attest [--run-id <id> | --latest] [--format text|json] | abandon (--run-id <id> | --latest-open) [--reason <text>] | profile export [--name <id>] [--from-run <id>] [--overwrite] [--format text|json] | profile seed --profile-file <path> [--run-id <id> | --latest-open] [--format text|json]"
---

# Runtime - Bootstrap

$ARGUMENTS

Run the machine bootstrap lifecycle. The **script owns facts, schemas, state,
and the completion reducer** (`docs/machine-bootstrap-contract.md` is the
normative contract); this command owns conversational pacing only — no schema
decision lives in this file.

```bash
RUNTIME_ROOT="${CLAUDE_PLUGIN_ROOT:-}"
if [ -z "$RUNTIME_ROOT" ]; then
  RUNTIME_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
fi

node "$RUNTIME_ROOT/scripts/bootstrap.mjs" $ARGUMENTS
```

## Interview pacing (the only thing this file owns)

Conduct the operator interview in this order — **diagnose →
profile-seeded-default → ask → render → apply-command → re-probe + confirm**:

1. **Diagnose first.** Run `plan --format json` (or `status` on an existing
   run) before asking anything. Live probe output is the evidence; never ask
   the operator a question the probe already answers.
2. **Profile-seeded defaults.** When the operator has a portable machine
   profile, run `profile seed --profile-file <path>` (or `plan --profile-file`,
   which is plan immediately followed by seed). Seeded values are **defaults
   requiring confirmation** — present them as pre-filled answers, never as
   decisions already made. Safety grading is the script's: an unsafe source
   value is shown as a labelled note, never presented as a default.
3. **Ask.** Walk the open steps stage by stage. Ask only about steps the
   contract makes declinable (notification, statusline — per host, egress, permission fragments,
   optional plugins, proofs), the two Stage-4 **value** steps, plus the bundle
   choice itself. Record the
   operator's decisions into a JSON answers file — an array of
   `{ "step_id": "...", "answer": "decline" | "accept" | "execute" | "attest-receipt" | "set:<key>=<value|unset>[;...]" }` —
   and pass it via `--answers` on `plan` or `resume`. **Answers reach the
   script only through that file** (prose-to-flag translation is unauditable);
   `--answers` is accepted on no other verb. `attest-receipt` (ADR-0048 §3) is
   the owner's phone-receipt testimony: it targets the egress provider-ack
   proof step only, and as an ANSWER it is accepted under `resume` only,
   never `plan` (no provider ack can exist yet, so there is nothing to
   testify about). The standalone `attest` verb records the same testimony
   post-terminally without an answers file.
3b. **Ask the two VALUE steps by presenting their menus, never from memory.**
   `config.session` and `config.notify_kinds` (contract §6.1.3) take a VALUE or a
   `decline` — never `accept`, which is refused because it would record a
   go-ahead while leaving every key undecided. `decline` is legal and is the
   supported opt-out ("leave this config unmanaged, stop asking"); offer it.
   Note it is NOT the same as choosing the shipped defaults — that is
   `set:<key>=unset`, which records the decision instead of refusing to make one. Each one renders
   a decision-menu fragment listing every legal value, the shipped default, and
   what leaving a key unset means; surface that menu rather than reciting the
   options, and re-read it after any re-answer (a changed decision re-renders it).

   Two things to get right when asking:

   - **`unset` is a real answer, not a skip.** It records "leave this key
     unwritten; the shipped default stands, deliberately". For `notify_kinds` it
     is the *recommended* answer — absence means future-open ALL kinds, so an
     enumeration of today's kinds is identical now and permanently narrower later.
     Enumerating every kind is refused for exactly that reason.
   - **A partial answer is legal.** Naming one key leaves the others undecided and
     the step pending; a later `set:` merges per key. Say which keys remain.

3c. **Opt into the optional proofs at PLAN time, or accept losing them.**
   `plan` now warns for every opt-in proof this run does not owe — today that is
   `proof.egress-provider-ack`. The warning is not noise: a run terminalizes as
   soon as every proof it DOES owe passes, `resume` refuses a terminal run, and
   an opt-in proof can then never be attached. Recovery is a fresh plan and a
   re-run of every proof, which costs minutes.

   **The canonical sequence, when the operator wants the egress proof:**

   ```
   plan   --answers <file>   # the egress opt-in — the ONE answer that does real
                             # work at plan time (§3: every other `execute` is
                             # refused here, because resume reads its own file)
   resume --answers <file>   # every proof to execute, in ONE file
   ```

   Execute the proofs in a SINGLE resume. Splitting them across resumes is the
   trap this warning exists for: the first resume whose owed set happens to pass
   terminalizes the run, and the proofs left for "the next one" have nowhere to
   go. Post-terminal, the only remaining door is the `attest` verb, and it
   records receipt testimony about an ALREADY-recorded ack — it cannot add a
   proof that was never run.

4. **Render.** The script renders host-config fragments into the run's
   `fragments/` directory and presents apply commands (including the
   plugin-management command carrying the plan hash). Surface them verbatim.
5. **Apply-command.** The **operator applies** every host-config change and
   runs the presented `runtime:settings --execute-plugin-management
   --expected-plan-hash <hash>` themselves. This command never applies a
   fragment and never executes plugin management (bootstrap presents; the
   existing settings executor executes — no second executor).
6. **Re-probe + confirm.** After the operator applies anything, run
   `resume --latest-open` — resume re-probes live state, persists step
   transitions, and (only on operator `execute` answers) records Stage-8
   proofs through `runtime:doctor --record`. A step is satisfied only when a
   post-probe observed it; never mark progress from the operator's say-so.

Notes:

- `status` and `verify` are read-only: they re-probe and re-judge in memory
  and write nothing. `verify` judges recorded proof evidence (absent / stale /
  passed / failed) — it never runs a proof to make itself pass.
- `attest` is the one post-terminal append (ADR-0048 §3): it records the
  owner's phone-receipt attestation for an already-recorded
  egress-provider-ack on a terminal run. It never re-runs a proof and never
  re-opens the run.
- A missing host CLI or missing marketplace registration surfaces the exact
  Stage 0 commands; Stage 0 is manual and host-native (ADR-0006).
- Exit codes: `0` complete; `10` configured-not-verified; `20` incomplete;
  `30` no-active-run; `40` invalid input; `50` legacy-historical (terminal
  run under an older schema minor — stored record summarized, nothing
  re-probed or re-certified); `1` unexpected error.
- Reports disclose only what the packaged schema grammar-clamps (contract
  §3.2). A historical run presents `legacy_completion_summary`, not the stored
  `completion`: proof verdicts, step ids and hashes cross, while free text
  (proof reasons, the stored artifact pointer) leaves as a count. Surface the
  summary's `source.artifact_pointer` when the operator needs the full record —
  reading the artifact is the escape hatch, and there is no flag for it.
- A second `plan` while a run is open is rejected — continue it with
  `resume --latest-open` or close it with `abandon`.
- Bootstrap's own artifacts live under the machine-global
  `~/.agentic-plugins/` home only; host config, credentials, and
  `config.local.toml` are never written, and bootstrap itself never opens
  the network. The delegated `runtime:doctor --record` proof invoked on an
  explicit `execute` answer records its doctor artifact under the repo's
  `.agentic-plugins/runs/doctor/`, and the egress proof's executor performs
  a real-network send behind the `AGENTIC_EGRESS_REAL_SMOKE=1` third
  consent — delegated effects are named, never silent.
