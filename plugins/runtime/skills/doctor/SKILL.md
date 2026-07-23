---
name: doctor
description: "Read-only runtime operator diagnostic for agentic-plugins. Use when the user wants to inspect Claude/Codex CLI availability, auth state, plugin marketplace/cache state, companion contract compatibility, model/effort observation, sandbox/permission readiness, workflow/peer-run ledger health, latest runtime:compat drift artifacts, ADR-0044 session-capture readiness (the half-enabled capture-chain states per session-capture-contract.md §13), ADR-0045 entry-brief hook-chain readiness (the entry_brief half-enabled states per contract §18, executor-existence probe included), generated runtime artifact inventory, or explicitly opted-in permission proof / egress provider-ack proof (ADR-0048 §3 real-network Stage-8 evidence) / deep peer smoke / workflow continuation proof execution. Does not mutate settings."
---

# Doctor (runtime framework primitive)

`runtime:doctor` is the first ADR-0024 operator surface. It is a read-only diagnostic, not a repair command.

## When invoked by command (`/runtime:doctor` or `$runtime:doctor`)

1. Resolve the plugin root.
   - Claude: `$CLAUDE_PLUGIN_ROOT` or the command file's plugin directory.
   - Codex: the installed skill directory's plugin root or the current repository checkout during development.
2. Run:

```bash
node "<runtime-plugin-root>/scripts/doctor.mjs" --repo-root "$REPO_ROOT" [--format text|json] [--model <id>] [--effort <level>] [--sandbox-permission-probe] [--permission-proof] [--execute-permission-proof] [--permission-proof-timeout-ms <n>] [--egress-ack-proof] [--execute-egress-ack-proof] [--deep-peer-smoke] [--execute-deep-peer-smoke] [--deep-peer-smoke-timeout-ms <n>] [--workflow-continuation-proof] [--execute-workflow-continuation-proof] [--workflow-continuation-proof-timeout-ms <n>] [--artifact-inventory] [--artifact-retention-cap <n>] [--artifact-max-bytes <n>] [--record]
```

3. Present the result without hiding host asymmetry. In particular:
   - Start from the `Readiness Matrix` / `readiness_matrix` summary when explaining whether Claude/Codex are available, installed, authenticated, which model/effort would be used, and where hook parity differs.
   - Use `Experience Parity` / `experience_parity` when the user asks for current goal progress. Treat its score as observed runtime readiness, not a completion claim for the entire project goal. The runtime handoff criterion includes `runtime:compat` state, so unresolved host-version drift can block the score until release-note evidence is attached.
   - If the Claude `claude plugin ...` CLI surface is unavailable to doctor, retired Claude plugin cleanup is required, or Codex packaged hooks still need active-session review/trust, surface the `Manual Follow-ups` checklist and its host-native `claude plugin ...` or `/hooks` commands instead of implying runtime can apply host-native changes automatically. The slash `/plugin` probe is observed separately and should not block management when the non-slash CLI is available.
   - Codex bundled plugin hooks require manifest exposure, an enabled hook gate (`[features].plugin_hooks` on Codex < ~0.134, or generic `[features].hooks` once `plugin_hooks` is removed), and active-session `/hooks` review/trust; surface those as separate readiness facts. Include per-plugin review targets with version, hook path, events, commands, and warnings so the operator can compare doctor output to `/hooks`. Also report `~/.codex/config.toml` `[hooks.state]` for expected bundled hooks, especially explicitly disabled entries. Do not treat `plugin_hooks=true`, marketplace/cache metadata, `/hooks` `Installed` counts, `Active=0`, disabled hook state, or `Trust: New hook - review required` as proof of hook trust. Warn when Codex-exposed hook commands still point at Claude adapter paths or rely on a bare `node` command that may not exist in the hook runner PATH; `CLAUDE_PLUGIN_ROOT`/`CLAUDE_PLUGIN_DATA` are compatibility aliases in Codex plugin hooks, while `PLUGIN_ROOT`/`PLUGIN_DATA` are preferred for new Codex commands. Remember the observed Codex CLI does not expose a non-interactive hook trust query.
   - The readiness summary reports sandbox/permission status as unknown unless `--sandbox-permission-probe` is requested. `--permission-proof` records separate preflight/execution evidence under `permission_proof`.
   - `--permission-proof` remains plan-only unless the user also supplies `--execute-permission-proof`. The executor uses the existing companion contract, does not pass sandbox/approval/permission-mode relaxation flags, classifies permission failures, and omits raw peer stdout from doctor output.
   - `--egress-ack-proof` remains plan-only (egress activation preflight: channel + recipient + credential presence, blockers, limits) unless the user also supplies `--execute-egress-ack-proof` AND `AGENTIC_EGRESS_REAL_SMOKE=1` is set in the environment — triple consent before any real network send (ADR-0048 §3). The executor delegates the one send attempt to the pinned `notify.mjs` emitter against an ephemeral temp repo (the active notify policy can still suppress it before any network I/O — kinds filter, quiet hours, dedupe, throttle — which fails the proof with its closed-enum reason), correlates the mirror row, reports only sanitized metadata (the provider-ack fact, closed-enum outcome reason, mirror correlation — never token, recipient, body, or raw provider response), and refuses to auto-resend while a pending intent record from a crashed attempt exists. There is deliberately no timeout flag for this executor. Owner phone-receipt attestation is a separate step (`bootstrap.mjs attest`), not part of this proof.
   - `--deep-peer-smoke` remains plan-only unless the user also supplies `--execute-deep-peer-smoke`. The executor uses the existing companion contract and omits raw peer stdout from doctor output.
   - `--workflow-continuation-proof` remains plan-only unless the user also supplies `--execute-workflow-continuation-proof`. The executor creates only ephemeral temp-repo engineer state, runs engineer `state.mjs` plus `dispatch-peer.mjs`, verifies pending/commit bookkeeping, and omits raw peer stdout and workflow bodies from doctor output.
   - `--artifact-inventory` is opt-in and read-only. It reports generated `.agentic-plugins/runs` counts, bytes, age metadata, and retention pressure without reading raw artifact bodies or deleting/compacting anything.
   - `--record` writes a sanitized `.agentic-plugins/runs/doctor/<run-id>/doctor.json` artifact. Treat it as reusable proof evidence only when doctor reports `recorded_doctor_proof.status=reusable`; runtime rejects reuse when runtime, host CLI, or plugin source/cache versions drift.
   - Authentication output must stay sanitized. Do not expose email, org id, token, or account secrets.

## Scope

Doctor reports:

- A top-level readiness matrix for Claude and Codex host availability, runtime installation evidence, authentication, direction-specific peer model/effort inputs, hook evidence, companion readiness, and sandbox/permission status.
- A top-level experience parity summary that scores observed cross-host readiness criteria and lists next actions without claiming the overall goal is complete.
- `claude` and `codex` CLI availability and version.
- Authentication state, sanitized to status and provider/method metadata.
- agentic-plugins marketplace entries, local source manifests, and known Claude/Codex cache state for `attention`, `companions`, `designer`, `engineer`, `founder`, `image`, `orchestrator`, and `runtime`.
- Manual Claude Code `claude plugin ...` follow-up commands when the host-native Claude plugin CLI is unavailable to doctor but source/cache state indicates install/update work remains, or when retired Claude plugin cleanup is required.
- Manual Codex `/hooks` follow-up when bundled plugin hooks are packaged and the stage-appropriate hook gate is enabled (`plugin_hooks` on Codex < ~0.134, or generic `[features].hooks` once `plugin_hooks` is removed) but runtime cannot verify active-session hook review/trust state; include review targets, explicitly disabled hook-state entries, and treat a current `runtime:settings --attest-codex-hook-review` artifact as the runtime-owned clearing signal only when the hook-bearing plugin set/source versions match and expected bundled hook state is not explicitly disabled.
- Codex plugin command surface — per-plugin `add`/`list`/`remove` plus marketplace `add`/`upgrade`/`remove` on Codex `0.137.0`+ (not full Claude parity: no update/enable/disable/details/validate/prune), or marketplace-only on older Codex — and cache materialization state when a temporary marketplace cache is current but no per-plugin install cache exists.
- Companion discovery and `companions/contract.md` compatibility.
- Current explicit and resolved model/effort inputs according to ADR-0024 order: command flags, workflow/subtask override observation, repo config, user config, host-native default.
- Codex -> Claude and Claude -> Codex companion sandbox/permission readiness as unknown by default, or as an explicit read-only preflight when `--sandbox-permission-probe` is requested.
- Optional `--sandbox-permission-probe` output, including per-direction CLI/auth/permission-surface/companion-script proof points without executing companions or peers.
- Optional `--permission-proof` plan-only preflight, including per-direction permission surface, model/effort inputs, blockers, warnings, and next-step guidance without executing peers.
- Optional `--permission-proof --execute-permission-proof` execution proof through the companion contract under host-native permission defaults. Output is bounded to status, exit codes, peer host/model metadata, timing, stdout byte count, stdout SHA-256, and sanitized permission-failure class; raw peer stdout is not printed into the main session.
- Optional `--egress-ack-proof` plan-only preflight, including egress activation state (channel + recipient + credential presence), blockers, and limits without performing any network request.
- Optional `--egress-ack-proof --execute-egress-ack-proof` execution proof (with the `AGENTIC_EGRESS_REAL_SMOKE=1` third consent) through the pinned `notify.mjs` emitter against an ephemeral temp repo. Output is bounded to provider-ack classification, a closed-enum outcome reason, and mirror correlation; token, recipient, message body, and raw provider responses are never printed or persisted, and a pending crashed-attempt intent blocks auto-resend until the operator clears it.
- Optional `--deep-peer-smoke` plan-only preflight, including per-direction readiness, model/effort inputs, blockers, warnings, and next-step guidance without executing peers.
- Optional `--deep-peer-smoke --execute-deep-peer-smoke` execution proof through the companion contract. Output is bounded to status, exit codes, peer host/model metadata, timing, stdout byte count, and stdout SHA-256; raw peer stdout is not printed into the main session.
- Optional `--workflow-continuation-proof` plan-only preflight, including per-direction engineer workflow state/dispatch readiness without executing peers.
- Optional `--workflow-continuation-proof --execute-workflow-continuation-proof` execution proof through engineer state creation, engineer dispatch-peer, pending ensemble verification, ensemble commit, and committed-result verification. Output is bounded to status, exit codes, peer host/model metadata, timing, stdout byte count, stdout SHA-256, and state-check booleans; raw peer stdout and temp workflow bodies are not printed into the main session.
- Latest `runtime:compat` snapshot/gap/plan metadata, including host-version drift, release-note requirement status, host gaps, and next actions. Doctor reads only bounded metadata and does not read raw release-note bodies or raw host help output.
- Optional `--artifact-inventory` output, including per-family `.agentic-plugins/runs` counts, bytes, oldest/newest metadata, and advisory retention pressure. Inventory uses filesystem metadata only and does not read artifact bodies.
- Optional `--record` output, including a sanitized doctor artifact pointer and latest pointer. Recorded proof artifacts can satisfy experience-parity proof criteria in later runs only while current runtime, host CLI, and plugin source/cache versions match the recorded report.
- Basic workflow and peer-run ledger health for canonical `.agentic-plugins/state/<plugin>` and legacy `.claude/agentic-*` homes, including migration ambiguity/blocker status.

## Out of Scope

- No install/update/uninstall.
- No auth automation.
- No settings writes. Use `runtime:settings` for dry-run settings plans and explicit agentic-plugins config apply.
- No ledger sweep/cancel/retention mutation.
- No dynamic consensus loop, context hygiene mutation, or completion footer mutation. Those are tracked in `docs/follow-ups.md`.
