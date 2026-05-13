# Changelog

## Unreleased

### Features

- Add `runtime:context`, an artifact-only context hygiene scaffold that writes summary, risk, artifact pointers, and next-session handoff files under `.agentic-plugins/runs/context/` without mutating host session context.
- Add `runtime:context check`, a read-only explicit context budget check that computes green/yellow/red risk without creating artifacts or mutating host session context.

## 0.1.0

- Initial runtime L1 framework primitive scaffold.
- Add read-only `runtime:doctor` command and Codex skill wrapper.
- Report host CLI/auth state, marketplace/cache discovery, companion contract compatibility, model/effort observation, companion readiness, and workflow/peer-run ledger health.
