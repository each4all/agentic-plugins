---
name: doctor
description: "Read-only runtime operator diagnostic for agentic-plugins. Use when the user wants to inspect Claude/Codex CLI availability, auth state, plugin marketplace/cache state, companion contract compatibility, model/effort observation, sandbox/permission readiness, workflow/peer-run ledger health, or explicitly opted-in permission proof / deep peer smoke execution. Does not mutate settings."
---

# Doctor (runtime framework primitive)

`runtime:doctor` is the first ADR-0024 operator surface. It is a read-only diagnostic, not a repair command.

## When invoked by command (`/runtime:doctor` or `$runtime:doctor`)

1. Resolve the plugin root.
   - Claude: `$CLAUDE_PLUGIN_ROOT` or the command file's plugin directory.
   - Codex: the installed skill directory's plugin root or the current repository checkout during development.
2. Run:

```bash
node "<runtime-plugin-root>/scripts/doctor.mjs" --repo-root "$REPO_ROOT" [--format text|json] [--model <id>] [--effort <level>] [--sandbox-permission-probe] [--permission-proof] [--execute-permission-proof] [--permission-proof-timeout-ms <n>] [--deep-peer-smoke] [--execute-deep-peer-smoke] [--deep-peer-smoke-timeout-ms <n>]
```

3. Present the result without hiding host asymmetry. In particular:
   - Codex may expose host-level hooks, but agentic-plugins has no verified plugin-local automatic hook packaging today.
   - The readiness summary reports sandbox/permission status as unknown unless `--sandbox-permission-probe` is requested. `--permission-proof` records separate preflight/execution evidence under `permission_proof`.
   - `--permission-proof` remains plan-only unless the user also supplies `--execute-permission-proof`. The executor uses the existing companion contract, does not pass sandbox/approval/permission-mode relaxation flags, classifies permission failures, and omits raw peer stdout from doctor output.
   - `--deep-peer-smoke` remains plan-only unless the user also supplies `--execute-deep-peer-smoke`. The executor uses the existing companion contract and omits raw peer stdout from doctor output.
   - Authentication output must stay sanitized. Do not expose email, org id, token, or account secrets.

## Scope

Doctor reports:

- `claude` and `codex` CLI availability and version.
- Authentication state, sanitized to status and provider/method metadata.
- agentic-plugins marketplace entries, local source manifests, and known Claude/Codex cache state for `companions`, `engineer`, `orchestrator`, and `runtime`.
- Companion discovery and `companions/contract.md` compatibility.
- Current explicit and resolved model/effort inputs according to ADR-0024 order: command flags, workflow/subtask override observation, repo config, user config, host-native default.
- Codex -> Claude and Claude -> Codex companion sandbox/permission readiness as unknown by default, or as an explicit read-only preflight when `--sandbox-permission-probe` is requested.
- Optional `--sandbox-permission-probe` output, including per-direction CLI/auth/permission-surface/companion-script proof points without executing companions or peers.
- Optional `--permission-proof` plan-only preflight, including per-direction permission surface, model/effort inputs, blockers, warnings, and next-step guidance without executing peers.
- Optional `--permission-proof --execute-permission-proof` execution proof through the companion contract under host-native permission defaults. Output is bounded to status, exit codes, peer host/model metadata, timing, stdout byte count, stdout SHA-256, and sanitized permission-failure class; raw peer stdout is not printed into the main session.
- Optional `--deep-peer-smoke` plan-only preflight, including per-direction readiness, model/effort inputs, blockers, warnings, and next-step guidance without executing peers.
- Optional `--deep-peer-smoke --execute-deep-peer-smoke` execution proof through the companion contract. Output is bounded to status, exit codes, peer host/model metadata, timing, stdout byte count, and stdout SHA-256; raw peer stdout is not printed into the main session.
- Basic workflow and peer-run ledger health for canonical `.agentic-plugins/state/<plugin>` and legacy `.claude/agentic-*` homes, including migration ambiguity/blocker status.

## Out of Scope

- No install/update/uninstall.
- No auth automation.
- No settings writes. Use `runtime:settings` for dry-run settings plans and explicit agentic-plugins config apply.
- No ledger sweep/cancel/retention mutation.
- No dynamic consensus loop, context hygiene mutation, or completion footer mutation. Those are tracked in `docs/follow-ups.md`.
