---
description: Machine-scoped, artifact-only bootstrap lifecycle — probe both hosts, plan a bundle install, render Stage 1-8 fragments and presented commands, resume with re-probe + proof recording, and verify recorded evidence
argument-hint: "plan [--bundle <id>] [--plugins <csv>] [--answers <path>] [--format text|json] | status [--run-id <id> | --latest | --latest-open] [--format text|json] | resume [--run-id <id> | --latest-open] [--answers <path>] [--format text|json] | verify [--run-id <id> | --latest] [--format text|json] | abandon (--run-id <id> | --latest-open) [--reason <text>]"
---

# Runtime - Bootstrap

$ARGUMENTS

Run the machine bootstrap lifecycle. The **script owns facts, schemas, state,
and the completion reducer** (`docs/machine-bootstrap-contract.md` is the
normative contract); this command owns conversational pacing only — no schema
decision lives in this file.

The arguments above reach the command through an args file, never through
the shell (ADR-0059): typed text spliced into a command line is cut at `;`,
expanded at `$(…)` and redirected at `>`, and the damage can exit zero.
Before the block below:

1. Create a private directory for the file, and note the path it prints:

   ```bash
   mktemp -d "${TMPDIR:-/tmp}/agentic-args.XXXXXX"
   ```

2. With your file-writing tool, not the shell, create `args.json` in that
   directory holding `{"agentic_args": 1, "text": "…"}`, with `text` set to
   the arguments above exactly as typed, as a JSON string (`""` when there
   are none).

Then run the block with `ARGS_DIR` set to that directory. The command reads
the text as shell-style words and expands nothing: quote a value that holds
spaces, and quote `;` `&` `|` `<` `>` `(` `)`, a backquote, a `$` expansion,
or a word-initial `#` or `~` to pass it as text — unquoted, each is refused
with a message rather than reinterpreted. The command removes the args file
and its directory once it has read them.

```bash
ARGS_DIR='<directory from step 1>'
RUNTIME_ROOT="${AGENTIC_RUNTIME_ROOT:-${CLAUDE_PLUGIN_ROOT}}"
[ -n "$RUNTIME_ROOT" ] || RUNTIME_ROOT="$(find ~/.claude/plugins/cache/agentic-plugins/runtime -mindepth 1 -maxdepth 1 -type d 2>/dev/null | grep -E '/(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$' | sort -V | tail -1)"

node "$RUNTIME_ROOT/scripts/bootstrap.mjs" --args-file "$ARGS_DIR/args.json"
```

## Interview pacing (the only thing this file owns)

Conduct the operator interview in this order — **diagnose → ask → render →
apply-command → re-probe + confirm**:

1. **Diagnose first.** Run `plan --format json` (or `status` on an existing
   run) before asking anything. Live probe output is the evidence; never ask
   the operator a question the probe already answers.
2. **Ask.** Walk the open steps stage by stage. Ask only about steps the
   contract makes declinable (the statusline — per host, optional plugins,
   proofs), the Stage-4 **value** step, plus the bundle choice itself. Record the
   operator's decisions into a JSON answers file — an array of
   `{ "step_id": "...", "answer": "decline" | "accept" | "execute" | "set:<key>=<value|unset>[;...]" }` —
   and pass it via `--answers` on `plan` or `resume`. **Answers reach the
   script only through that file** (prose-to-flag translation is unauditable);
   `--answers` is accepted on no other verb. An `execute` answer is accepted
   under `resume` only, never `plan`, and only against a `proof.*` step.
2b. **Ask the VALUE step by presenting its menu, never from memory.**
   `config.session` (contract §6.1.3) takes a VALUE or a `decline` — never
   `accept`, which is refused because it would record a go-ahead while leaving
   every key undecided. `decline` is legal and is the supported opt-out ("leave
   this config unmanaged, stop asking"); offer it. Note it is NOT the same as
   choosing the shipped defaults — that is `set:<key>=unset`, which records the
   decision instead of refusing to make one. The step renders a decision-menu
   fragment listing every legal value, the shipped default, and what leaving a
   key unset means; surface that menu rather than reciting the options, and
   re-read it after any re-answer (a changed decision re-renders it).

   Two things to get right when asking:

   - **`unset` is a real answer, not a skip.** It records "leave this key
     unwritten; the shipped default stands, deliberately".
   - **A partial answer is legal.** Naming one key leaves the others undecided and
     the step pending; a later `set:` merges per key. Say which keys remain.

2c. **Execute the proofs in ONE resume.** A run terminalizes as soon as every
   proof it owes passes, and `resume` refuses a terminal run. Put every proof
   the operator wants executed into a SINGLE `resume --answers <file>`; a proof
   left for "the next resume" may have nowhere to go.

3. **Render.** The script renders host-config fragments into the run's
   `fragments/` directory and presents apply commands (including the
   plugin-management command carrying the plan hash). Surface them verbatim.
4. **Apply-command.** The **operator applies** every host-config change and
   runs the presented `runtime:settings --execute-plugin-management
   --expected-plan-hash <hash>` themselves. This command never applies a
   fragment and never executes plugin management (bootstrap presents; the
   existing settings executor executes — no second executor).
5. **Re-probe + confirm.** After the operator applies anything, run
   `resume --latest-open` — resume re-probes live state, persists step
   transitions, and (only on operator `execute` answers) records Stage-8
   proofs through `runtime:doctor --record`. A step is satisfied only when a
   post-probe observed it; never mark progress from the operator's say-so.

Notes:

- `status` and `verify` are read-only: they re-probe and re-judge in memory
  and write nothing. `verify` judges recorded proof evidence (absent / stale /
  passed / failed) — it never runs a proof to make itself pass.
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
- A run recorded by an earlier minor is read as history (terminal, exit `50`) or
  migrated on `resume` (open); retired notification and egress rows are dropped
  and named in the migration history row (contract §7). `abandon` stays the way
  out of a run the operator does not want to finish.
- A second `plan` while a run is open is rejected — continue it with
  `resume --latest-open` or close it with `abandon`.
- Bootstrap's own artifacts live under the machine-global
  `~/.agentic-plugins/` home only; host config, credentials, and
  `config.local.toml` are never written, and bootstrap itself never opens
  the network. The delegated `runtime:doctor --record` proof invoked on an
  explicit `execute` answer records its doctor artifact under the repo's
  `.agentic-plugins/runs/doctor/` — delegated effects are named, never silent.
