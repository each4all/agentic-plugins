---
name: bootstrap
description: "Machine-scoped, artifact-only bootstrap lifecycle. Use when the user wants to bring a machine from a bare host to a proven install: probe both host CLIs live, plan a bundle (base|engineering|business|design|full|custom) with hard-dependency closure, print Stage 0 commands for a missing peer host or marketplace registration, render the Stage 4-5 model/effort, notification, statusline, and egress launcher fragments per host with backup and revert guidance, present the plugin-management command carrying its plan hash, resume with live re-probe plus proof recording through runtime:doctor --record, verify recorded proof evidence without running a proof to make itself pass, attest the owner's phone receipt, and abandon a crashed run. bootstrap never executes; status and verify are read-only; artifacts land only under ~/.agentic-plugins; host config, credentials, and config.local.toml are never written."
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
node "<runtime-plugin-root>/scripts/bootstrap.mjs" plan     [--bundle <id>] [--plugins <csv>] [--answers <path>] [--format text|json]
node "<runtime-plugin-root>/scripts/bootstrap.mjs" status   [--run-id <id> | --latest | --latest-open] [--format text|json]
node "<runtime-plugin-root>/scripts/bootstrap.mjs" resume   [--run-id <id> | --latest-open] [--answers <path>] [--format text|json]
node "<runtime-plugin-root>/scripts/bootstrap.mjs" verify   [--run-id <id> | --latest] [--format text|json]
node "<runtime-plugin-root>/scripts/bootstrap.mjs" attest   [--run-id <id> | --latest] [--format text|json]
node "<runtime-plugin-root>/scripts/bootstrap.mjs" abandon  (--run-id <id> | --latest-open) [--reason <text>]
```

Pass the subcommand and options above through an args file, never on the
command line (ADR-0059): text spliced into a shell line is cut at `;`,
expanded at `$(…)` and redirected at `>`. Create a directory with
`mktemp -d "${TMPDIR:-/tmp}/agentic-args.XXXXXX"`, write `args.json` in it
with your file-editing tool, holding `{"agentic_args": 1, "text": "…"}` with
`text` set to them as a JSON string, and run:

```bash
ARGS_DIR='<directory mktemp printed>'
node "<runtime-plugin-root>/scripts/bootstrap.mjs" --args-file "$ARGS_DIR/args.json"
```

`text` is read as shell-style words that expand nothing: quote a value that
holds spaces, and quote `;` `&` `|` `<` `>` `(` `)`, a backquote, a `$`
expansion, or a word-initial `#` or `~` — unquoted, each is refused with a
message. The command removes the args file and its directory once it has
read them.

3. Pace the interview as **diagnose → ask → render → apply-command → re-probe +
   confirm**:
   - **Diagnose**: run `plan` / `status` first; the live probe answers most
     questions. Never ask what the probe already observed.
   - **Ask**: only about declinable steps (notification, statusline — per
     host, egress, optional plugins, proofs) and the
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
  (runs), and bootstrap itself never opens the network. Host
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
- No permission-relaxing default: bootstrap proposes no permission posture at
  all, and no runtime surface ships a default or hook that relaxes one — never
  Claude `bypassPermissions`, Codex `approval_policy = "never"`, or
  `sandbox_mode = "danger-full-access"` (ADR-0057 §Decision 8, ADR-0038 §6).
  The machine-profile seeding that once had to grade such values was removed
  by ADR-0064 Decision 3 (2026-10-04).
- Stage 0 (host CLI install + marketplace registration) is manual and
  host-native; bootstrap prints the exact commands and stops there.
- One-host machines reduce to `incomplete` by design (§8.3 honest scope) —
  do not promise `configured-not-verified` there.
