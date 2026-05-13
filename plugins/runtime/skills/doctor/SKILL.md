---
name: doctor
description: "Read-only runtime operator diagnostic for agentic-plugins. Use when the user wants to inspect Claude/Codex CLI availability, auth state, plugin marketplace/cache state, companion contract compatibility, model/effort observation, sandbox/permission readiness, and workflow/peer-run ledger health. Does not mutate settings or run peer agents."
---

# Doctor (runtime framework primitive)

`runtime:doctor` is the first ADR-0024 operator surface. It is a read-only diagnostic, not a repair command.

## When invoked by command (`/runtime:doctor` or `$runtime:doctor`)

1. Resolve the plugin root.
   - Claude: `$CLAUDE_PLUGIN_ROOT` or the command file's plugin directory.
   - Codex: the installed skill directory's plugin root or the current repository checkout during development.
2. Run:

```bash
node "<runtime-plugin-root>/scripts/doctor.mjs" --repo-root "$REPO_ROOT" [--format text|json] [--model <id>] [--effort <level>] [--deep-peer-smoke]
```

3. Present the result without hiding host asymmetry. In particular:
   - Codex has no verified plugin-local automatic hook packaging today.
   - Read-only doctor reports sandbox/permission readiness as unknown/read-only inference from CLI/auth/companion state; it cannot prove a peer run will succeed unless a future explicit deep smoke implementation is added.
   - Authentication output must stay sanitized. Do not expose email, org id, token, or account secrets.

## Scope

Doctor reports:

- `claude` and `codex` CLI availability and version.
- Authentication state, sanitized to status and provider/method metadata.
- agentic-plugins marketplace entries, local source manifests, and known Claude/Codex cache state for `companions`, `engineer`, `orchestrator`, and `runtime`.
- Companion discovery and `companions/contract.md` compatibility.
- Current explicit and resolved model/effort inputs according to ADR-0024 order: command flags, workflow/subtask override observation, repo config, user config, host-native default.
- Codex -> Claude and Claude -> Codex companion sandbox/permission readiness as read-only inference.
- Basic workflow and peer-run ledger health for `.claude/agentic-engineer` and `.claude/agentic-orchestrator`.

## Out of Scope

- No `runtime:settings` in this PR.
- No install/update/uninstall.
- No auth automation.
- No settings writes.
- No ledger sweep/cancel/retention mutation.
- No dynamic consensus loop, context hygiene mutation, or completion footer mutation. Those are tracked in `docs/follow-ups.md`.
