---
name: bootstrap
description: "Machine-scoped, artifact-only bootstrap lifecycle for agentic-plugins. Use when the user wants to bring a machine from a bare host to a proven install: probe both host CLIs live, plan a bundle (base|engineering|business|design|full|custom) with hard-dependency closure, print exact Stage 0 commands for a missing peer host or missing marketplace registration, render Stage 4-6 fragments (model/effort, notification, statusline — per host, with the credential-free shim artifact, egress launcher, BOTH permission plans) with backup/verify/manual-revert guidance, present the plugin-management command carrying the §1.6 plan hash (the settings executor refuses on divergence — bootstrap never executes), resume with live re-probe + explicit proof recording through runtime:doctor --record, verify recorded proof evidence (absent/stale/passed/failed — never runs a proof to make itself pass), attest the owner's phone receipt onto a terminal run's recorded egress-provider-ack (ADR-0048 §3 — the one post-terminal append), abandon a crashed run, and export/seed a portable secrets-free machine profile. status/verify are read-only; artifacts land only under the machine-global ~/.agentic-plugins home; host config, credentials, and config.local.toml are never written."
---

# Bootstrap (runtime framework primitive)

`runtime:bootstrap` is the ADR-0046 machine bootstrap lifecycle. The **script
owns facts, schemas, state, and the completion reducer** (normative contract:
`docs/machine-bootstrap-contract.md`, packaged in this plugin); this skill owns
conversational pacing only. No schema decision lives in this file.

## When invoked by command (`/runtime:bootstrap` or `$runtime:bootstrap`)

1. Resolve the plugin root.
   - Claude: `$CLAUDE_PLUGIN_ROOT` or the command file's plugin directory.
   - Codex: the installed skill directory's plugin root or the current
     repository checkout during development.
2. Run the requested verb:

```bash
node "<runtime-plugin-root>/scripts/bootstrap.mjs" plan     [--bundle <id>] [--plugins <csv>] [--profile-file <path>] [--answers <path>] [--format text|json]
node "<runtime-plugin-root>/scripts/bootstrap.mjs" status   [--run-id <id> | --latest | --latest-open] [--format text|json]
node "<runtime-plugin-root>/scripts/bootstrap.mjs" resume   [--run-id <id> | --latest-open] [--answers <path>] [--format text|json]
node "<runtime-plugin-root>/scripts/bootstrap.mjs" verify   [--run-id <id> | --latest] [--format text|json]
node "<runtime-plugin-root>/scripts/bootstrap.mjs" attest   [--run-id <id> | --latest] [--format text|json]
node "<runtime-plugin-root>/scripts/bootstrap.mjs" abandon  (--run-id <id> | --latest-open) [--reason <text>]
node "<runtime-plugin-root>/scripts/bootstrap.mjs" profile export [--name <id>] [--from-run <id>] [--overwrite]
node "<runtime-plugin-root>/scripts/bootstrap.mjs" profile seed   --profile-file <path> [--run-id <id> | --latest-open]
```

3. Pace the interview as **diagnose → profile-seeded-default → ask → render →
   apply-command → re-probe + confirm**:
   - **Diagnose**: run `plan` / `status` first; the live probe answers most
     questions. Never ask what the probe already observed.
   - **Profile-seeded defaults**: with a portable profile, `profile seed`
     pre-fills interview defaults. Present each as a default **requiring
     confirmation**; unsafe source values arrive as labelled notes, never
     defaults (the script safety-grades — this skill never overrides that).
   - **Ask**: only about declinable steps (notification, statusline — per
     host, egress, permission fragments, optional plugins, proofs) and the
     bundle. Collect decisions into a JSON answers file
     `[{ "step_id", "answer": "decline"|"accept"|"execute"|"attest-receipt" }]`
     and pass it via `--answers` on `plan` or `resume` — the only two verbs
     that accept it. Prose never reaches the script directly.
     `attest-receipt` (ADR-0048 §3) is the owner's phone-receipt testimony:
     it targets the egress provider-ack proof step only, and as an ANSWER it
     is accepted under `resume` only, never `plan`. The standalone `attest`
     verb records the same testimony post-terminally without an answers
     file.
   - **Render / apply-command**: surface the rendered fragments and presented
     commands verbatim, including the plugin-management command carrying the
     plan hash and each fragment's backup/verify/manual-revert guidance. The
     **operator** applies fragments and runs the presented
     `runtime:settings --execute-plugin-management --expected-plan-hash <hash>`.
   - **Re-probe + confirm**: after any operator action, `resume --latest-open`.
     Only a live post-probe promotes a step; operator say-so never does.
4. Present completion honestly: `complete` and `configured-not-verified` are
   different terminal states — "installed" and "proven" are not the same claim.
   Exit codes: 0 complete / 10 configured-not-verified / 20 incomplete /
   30 no-active-run / 40 invalid input / 50 legacy-historical (terminal run
   under an older schema minor — stored record summarized, nothing
   re-certified) / 1 unexpected.
5. A historical run reports `legacy_completion_summary`, never the stored
   `completion`: verdicts, step ids and hashes cross the boundary, free text
   (proof reasons, the stored artifact pointer) leaves as a count (contract
   §3.2). Do not reconstruct the withheld text from elsewhere — point the
   operator at `source.artifact_pointer` instead.

## Boundaries (surface these when relevant; never work around them)

- Machine-scoped: never reasons about the invoking repository's source tree;
  consumer-repo invocations emit no source-tree remediation.
- Artifact-only: bootstrap's own writes land only under `~/.agentic-plugins/`
  (runs + profiles), and bootstrap itself never opens the network. Host
  config, credentials, and `config.local.toml` are never written. Delegated
  effects are named, never silent: EVERY proof driven by an explicit
  operator `execute` answer runs through `runtime:doctor --record`, which
  records its doctor artifact under the repo's `.agentic-plugins/runs/doctor/`;
  the egress proof's executor additionally performs the one real-network
  send, behind the `AGENTIC_EGRESS_REAL_SMOKE=1` third consent.
- No second executor: plugin management is presented to
  `runtime:settings --execute-plugin-management`; proofs run only through
  `runtime:doctor --record` under `resume`, and only on an explicit operator
  `execute` answer.
- Stage 0 (host CLI install + marketplace registration) is manual and
  host-native; bootstrap prints the exact commands and stops there.
- One-host machines reduce to `incomplete` by design (§8.3 honest scope) —
  do not promise `configured-not-verified` there.
