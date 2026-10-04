---
name: doctor
description: "Read-only runtime operator diagnostic for agentic-plugins. Use when the user wants to inspect Claude/Codex CLI availability, auth state, plugin marketplace/cache state, companion contract compatibility, model/effort observation, workflow/peer-run ledger health, observed host versions (reported as facts; host-version tracking was removed by ADR-0060), ADR-0044 session-capture readiness (the half-enabled capture-chain states per session-capture-contract.md §13), ADR-0045 entry-brief hook-chain readiness (the entry_brief half-enabled states per contract §18, executor-existence probe included), generated runtime artifact inventory, or explicitly opted-in permission proof / deep peer smoke / workflow continuation proof execution. Does not mutate settings."
---

# Doctor (runtime framework primitive)

`runtime:doctor` is the first ADR-0024 operator surface. It is a read-only diagnostic, not a repair command.

## When invoked by command (`/runtime:doctor` or `$runtime:doctor`)

1. Resolve the plugin root.
   - Claude: `$CLAUDE_PLUGIN_ROOT` or the command file's plugin directory.
   - Codex: the installed skill directory's plugin root or the current repository checkout during development.
2. Run:

```bash
node "<runtime-plugin-root>/scripts/doctor.mjs" --repo-root "$REPO_ROOT" [--format text|json] [--model <id>] [--effort <level>] [--permission-proof] [--execute-permission-proof] [--permission-proof-timeout-ms <n>] [--deep-peer-smoke] [--execute-deep-peer-smoke] [--deep-peer-smoke-timeout-ms <n>] [--workflow-continuation-proof] [--execute-workflow-continuation-proof] [--workflow-continuation-proof-timeout-ms <n>] [--artifact-inventory] [--artifact-retention-cap <n>] [--artifact-max-bytes <n>] [--record] [--strict]
```

Pass the subcommand and options above through an args file, never on the
command line (ADR-0059): text spliced into a shell line is cut at `;`,
expanded at `$(…)` and redirected at `>`. Create a directory with
`mktemp -d "${TMPDIR:-/tmp}/agentic-args.XXXXXX"`, write `args.json` in it
with your file-editing tool, holding `{"agentic_args": 1, "text": "…"}` with
`text` set to them as a JSON string, and run:

```bash
ARGS_DIR='<directory mktemp printed>'
node "<runtime-plugin-root>/scripts/doctor.mjs" --repo-root "$REPO_ROOT" --args-file "$ARGS_DIR/args.json"
```

`text` is read as shell-style words that expand nothing: quote a value that
holds spaces, and quote `;` `&` `|` `<` `>` `(` `)`, a backquote, a `$`
expansion, or a word-initial `#` or `~` — unquoted, each is refused with a
message. The command removes the args file and its directory once it has
read them.

   Exit codes: `0` no hard failures and every requested proof executor passed; `10`
   findings (`overall.status` is `fail`, or `warning` under the opt-in `--strict`); `20` a
   requested proof produced no usable verdict for some lane; `30` a requested proof needs an
   operator action in the host; `40` `--record` could not persist its artifact; `2` invalid
   usage; `1` unexpected. Codes `10` and above still write the complete report to stdout — read
   the report and treat the code as a classifier, not as a command failure. Only `1` and `2`
   produce no report, and `40` hides any findings underneath it, so read `overall.status` too.

3. Present the result without hiding host asymmetry. In particular:
   - Start from the `Readiness Matrix` / `readiness_matrix` summary when explaining whether Claude/Codex are available, installed, authenticated, which model/effort would be used, and where hook parity differs.
   - Use `Experience Parity` / `experience_parity` when the user asks for current goal progress. Treat its score as observed runtime readiness, not a completion claim for the entire project goal. ⚠ **The denominator changed** (ADR-0056 §Decision 8): `host_compatibility_assurance` was the ninth criterion, carried weight 15, and is removed with the layer — so the criterion count, the total weight, the score, and possibly the headline all moved. That is a scoring change, not a field deletion, and `runtime-experience-parity` bumped for it. `runtime_handoff_artifacts` is about whether the recorded artifacts are READABLE for handoff; since ADR-0060 it reads the settings and consensus collections only (the compat collection went with `runtime:compat`), at unchanged weight, and `runtime-experience-parity` bumped to 1.2 for it. A `blocked` handoff row means a malformed settings or consensus artifact; `partial` means a collection is missing.
   - If the Claude `claude plugin ...` CLI surface is unavailable to doctor, retired Claude plugin cleanup is required, or Codex packaged hooks still need active-session review/trust, surface the `Manual Follow-ups` checklist and its host-native `claude plugin ...` or `/hooks` commands instead of implying runtime can apply host-native changes automatically. The slash `/plugin` probe is observed separately and should not block management when the non-slash CLI is available.
   - Codex bundled plugin hooks require manifest exposure, an enabled hook gate (`[features].plugin_hooks` on Codex < ~0.134, or generic `[features].hooks` once `plugin_hooks` is removed), and active-session `/hooks` review/trust; surface those as separate readiness facts. Include per-plugin review targets with version, hook path, events, commands, and warnings so the operator can compare doctor output to `/hooks`. Also report `~/.codex/config.toml` `[hooks.state]` for expected bundled hooks, especially explicitly disabled entries. Do not treat `plugin_hooks=true`, marketplace/cache metadata, `/hooks` `Installed` counts, `Active=0`, disabled hook state, or `Trust: New hook - review required` as proof of hook trust. Warn when Codex-exposed hook commands still point at Claude adapter paths or rely on a bare `node` command that may not exist in the hook runner PATH; `CLAUDE_PLUGIN_ROOT`/`CLAUDE_PLUGIN_DATA` are compatibility aliases in Codex plugin hooks, while `PLUGIN_ROOT`/`PLUGIN_DATA` are preferred for new Codex commands. Remember the observed Codex CLI does not expose a non-interactive hook trust query.
   - The readiness summary does not judge companion permission state. `--permission-proof` records a read-only per-direction preflight, and with `--execute-permission-proof` execution evidence, under `permission_proof`. There is no sandbox permission probe: `--sandbox-permission-probe` was removed by ADR-0064 Decision 4, and doctor refuses it as an unknown argument (exit `2`, no report). If the user asks for it, run `--permission-proof`, whose preflight carries the same read-only evidence.
   - `--permission-proof` remains plan-only unless the user also supplies `--execute-permission-proof`. The executor uses the existing companion contract, does not pass sandbox/approval/permission-mode relaxation flags, classifies permission failures, and omits raw peer stdout from doctor output.
   - There is no egress provider-ack proof. `--egress-ack-proof` and `--execute-egress-ack-proof` were removed with notification and egress by ADR-0064 Decision 1, and doctor refuses them as unknown arguments (exit `2`, no report). If the user asks for that proof, say it no longer exists rather than running doctor without it.
   - `--deep-peer-smoke` remains plan-only unless the user also supplies `--execute-deep-peer-smoke`. The executor uses the existing companion contract and omits raw peer stdout from doctor output.
   - `--workflow-continuation-proof` remains plan-only unless the user also supplies `--execute-workflow-continuation-proof`. The executor creates only ephemeral temp-repo engineer state, runs engineer `state.mjs` plus `dispatch-peer.mjs`, verifies pending/commit bookkeeping, and omits raw peer stdout and workflow bodies from doctor output.
   - `--artifact-inventory` is opt-in and read-only. It reports generated `.agentic-plugins/runs` counts, bytes, age metadata, and retention pressure without reading raw artifact bodies or deleting/compacting anything.
   - `--record` writes a sanitized `.agentic-plugins/runs/doctor/<run-id>/doctor.json` artifact. Treat it as reusable proof evidence only when doctor reports `recorded_doctor_proof.status=reusable`; runtime rejects reuse when runtime, host CLI, or plugin source/cache versions drift.
   - Authentication output must stay sanitized. Do not expose email, org id, token, or account secrets.

## Scope

Doctor reports:

- A top-level readiness matrix for Claude and Codex host availability, runtime installation evidence, authentication, direction-specific peer model/effort inputs, hook evidence, and companion readiness.
- A top-level experience parity summary that scores observed cross-host readiness criteria and lists next actions without claiming the overall goal is complete.
- `claude` and `codex` CLI availability and version.
- Authentication state, sanitized to status and provider/method metadata.
- agentic-plugins marketplace entries, local source manifests, and known Claude/Codex cache state for `attention`, `companions`, `designer`, `engineer`, `founder`, `image`, `orchestrator`, and `runtime`.
- Manual Claude Code `claude plugin ...` follow-up commands when the host-native Claude plugin CLI is unavailable to doctor but source/cache state indicates install/update work remains, or when retired Claude plugin cleanup is required.
- Manual Codex `/hooks` follow-up when bundled plugin hooks are packaged and the stage-appropriate hook gate is enabled (`plugin_hooks` on Codex < ~0.134, or generic `[features].hooks` once `plugin_hooks` is removed) but runtime cannot verify active-session hook review/trust state; include review targets, explicitly disabled hook-state entries, and treat a current `runtime:settings --attest-codex-hook-review` artifact as the runtime-owned clearing signal only when the Codex CLI version, the hook-bearing plugin set, and the Codex-installed plugin versions match and expected bundled hook state is not explicitly disabled.
- Codex plugin command surface — per-plugin `add`/`list`/`remove` plus marketplace `add`/`upgrade`/`remove` on Codex `0.137.0`+ (not full Claude parity: no update/enable/disable/details/validate/prune), or marketplace-only on older Codex — and cache materialization state when a temporary marketplace cache is current but no per-plugin install cache exists.
- Companion discovery and `companions/contract.md` compatibility.
- Current explicit and resolved model/effort inputs according to ADR-0024 order: command flags, workflow/subtask override observation, repo config, user config, host-native default.
- Optional `--permission-proof` plan-only preflight, including per-direction CLI/auth/permission-surface/companion-script proof points, model/effort inputs, blockers, warnings, and next-step guidance without executing companions or peers.
- Optional `--permission-proof --execute-permission-proof` execution proof through the companion contract under host-native permission defaults. Output is bounded to status, exit codes, peer host/model metadata, timing, stdout byte count, stdout SHA-256, and sanitized permission-failure class; raw peer stdout is not printed into the main session.
- Optional `--deep-peer-smoke` plan-only preflight, including per-direction readiness, model/effort inputs, blockers, warnings, and next-step guidance without executing peers.
- Optional `--deep-peer-smoke --execute-deep-peer-smoke` execution proof through the companion contract. Output is bounded to status, exit codes, peer host/model metadata, timing, stdout byte count, and stdout SHA-256; raw peer stdout is not printed into the main session.
- Optional `--workflow-continuation-proof` plan-only preflight, including per-direction engineer workflow state/dispatch readiness without executing peers.
- Optional `--workflow-continuation-proof --execute-workflow-continuation-proof` execution proof through engineer state creation, engineer dispatch-peer, pending ensemble verification, ensemble commit, and committed-result verification. Output is bounded to status, exit codes, peer host/model metadata, timing, stdout byte count, stdout SHA-256, and state-check booleans; raw peer stdout and temp workflow bodies are not printed into the main session.
- Observed host versions (`claude --version`, `codex --version`) under `clis`, as facts with **no verdict**. ⚠ ADR-0060 removed host-version tracking — the packaged host-parity baseline, `runtime:compat`, and the baseline integrity/exactness check (ADR-0053 §Decision 3 as narrowed by ADR-0056) all went. Never report, imply, or await a verdict that the installed host pair is the reviewed one: nothing compares the versions against anything, and host drift is discovered when a surface breaks. ADR-0056 had already removed the *assurance* layer (a human-authored grant over host-version tuples) for the same arithmetic.

  Historical assurance results in retained doctor artifacts are still decoded, reported under `historical_assurance` with their `schema_era`, and never mapped onto a current status. Retained artifacts of every earlier doctor schema era (report `runtime-doctor-1.0` through `1.3`) stay readable beside the current `1.4` (artifact `runtime-doctor-artifact-1.4`), which ADR-0064 introduced when the report lost `egress_ack_proof`, `sandbox_permission_probe` and the per-direction `sandbox_permission` members, in one bump. On a partially upgraded host pair, the host still on a runtime release from before the 1.4 schema counts a 1.4 artifact `malformed`, and its dashboard reports the doctor row blocked, until that host installs the release too; so install a release on both hosts before recording a proof.
- Optional `--artifact-inventory` output, including per-family `.agentic-plugins/runs` counts, bytes, oldest/newest metadata, and advisory retention pressure. Inventory uses filesystem metadata only and does not read artifact bodies.
- Optional `--record` output, including a sanitized doctor artifact pointer and latest pointer. Recorded proof artifacts can satisfy experience-parity proof criteria in later runs only while current runtime, host CLI, and plugin source/cache versions match the recorded report.
- Basic workflow and peer-run ledger health for canonical `.agentic-plugins/state/<plugin>` and legacy `.claude/agentic-*` homes, including migration ambiguity/blocker status.

## Out of Scope

- No install/update/uninstall.
- No auth automation.
- No settings writes. Use `runtime:settings` for dry-run settings plans and explicit agentic-plugins config apply.
- No ledger sweep/cancel/retention mutation.
- No dynamic consensus loop, context hygiene mutation, or completion footer mutation. Those are tracked in `docs/follow-ups.md`.
