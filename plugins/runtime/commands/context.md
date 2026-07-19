---
description: Runtime-owned context hygiene artifact scaffold, read-only budget check, ADR-0044 session-capture note staging, hook-fired slot publication, validated slot inspection, and the ADR-0045 read-only entry-brief arbiter
argument-hint: "capture|status|check|note|publish-session|entry-brief [--format text|json] [--summary <text>|--summary-file <path>] [--risk green|yellow|red] [--token-budget <n>] [--used-tokens <n>|--remaining-tokens <n>] [--artifact kind:<repo-path>] [--next-action <text>] [--next-session-prompt <text>|--next-session-prompt-file <path>] [--run-id <id>|--latest|--slot] [--stale-after-hours <n>] [--text <text>|--file <path>|--clear] [--host claude|codex] [--session-id <id>] [--workflow-evidence none|fresh] [--surface session-start-hook|cli|dashboard]"
---

# Runtime - Context

$ARGUMENTS

Run the runtime-owned context hygiene artifact scaffold and read-only budget check. This command does not trim, rewrite, or mutate host session context. It also does not compact host session context. `capture` writes a bounded repo-local artifact and records a read-only git source snapshot when available; `status` reads one by explicit run id or latest-artifact lookup and reports age, source freshness, and explicit handoff guidance for whether to reuse the artifact or capture a fresh one; `check` only computes an advisory green/yellow/red risk from caller-supplied inputs. The ADR-0044 session-capture surface: `note` stages a semantic handoff note (`--text`/`--file`/`--clear`) into the repo-local staging slot, and `status --slot` inspects the validated slot/entry/note files read-only. `publish-session` is the hook-fired slot publisher (ADR-0044 §10) — hook-grade by definition (exit 0 always, nothing on stdout, at most one stderr line, no reporter mode), gated by the `session_capture` config key (default `off`), intended for the attention Stop sensor rather than interactive use; operators inspect its output via `status --slot` and opt in via `runtime:settings`. The ADR-0045 entry surface: `entry-brief` is the R0 entry arbiter — bounded reads over the persona/orchestrator state homes, the macro bridge, the handoff slots, the session-capture entry.json, and the runtime ledgers; one pointer-only brief (contract §15) with at most one synthesized, host-localized command from the §16 lattice. `--surface cli` (default) and `--surface dashboard` always compute; `--surface session-start-hook` is hook-grade and gated by the user-scope-only `entry_brief` key (env > user-global > default, default `off`), with `entry_brief_empty` deciding whether `owner-choice-required` emits (`no-branch-context` and `indeterminate` stay hook-silent).

```bash
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
RUNTIME_ROOT="${CLAUDE_PLUGIN_ROOT:-}"
if [ -z "$RUNTIME_ROOT" ]; then
  RUNTIME_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
fi

node "$RUNTIME_ROOT/scripts/context.mjs" --repo-root "$REPO_ROOT" $ARGUMENTS
```

Common flow:

```bash
/runtime:context capture --summary "Runtime PR context summary" --risk yellow --next-action "Start a fresh session before the next large change."
/runtime:context capture --summary-file context-summary.md --artifact consensus:.agentic-plugins/runs/consensus/<run-id>/consensus.json
/runtime:context status --run-id <id>
/runtime:context status --latest --stale-after-hours 12
/runtime:context check --token-budget 100000 --used-tokens 82000
/runtime:context check --risk yellow --risk-reason "Long implementation session."
/runtime:context note --text "S3a executor landed; tests green; PR next."
/runtime:context note --file handoff-note.md
/runtime:context note --clear
/runtime:context status --slot
/runtime:context entry-brief --host claude
```

Notes:

- Context artifacts stay under `<repo>/.agentic-plugins/runs/context/<run-id>/`.
- `status --latest` reads the newest readable context artifact and reports age/stale handoff metadata, source-freshness metadata, and bounded handoff guidance; it does not create or update artifacts.
- Handoff guidance is advisory. Stale age, stale source commits, unknown source metadata, dirty current worktrees, or artifacts captured from a dirty worktree recommend a fresh capture before relying on the artifact as next-session truth.
- Context artifacts include Claude, Codex, and neutral handoff commands for the same run id so either host can resume from the same artifact pointer.
- `check` is read-only and does not create a context artifact or trigger `capture`.
- Main-session output is limited to context summary, risk level, artifact pointers, and recommended next-session prompt/action.
- Source freshness uses read-only git observation only. If git metadata is unavailable, source freshness is reported as `unknown` rather than inferred.
- Context budget checks use explicit caller-supplied values only; this command does not measure Claude or Codex host context automatically.
- This command does not migrate persona workflow state.
- Consensus raw output and peer raw output must be referenced by artifact pointer only.
- Codex plugin-hook feature/trust state and permission limits are reported as limits, not host parity.
- `note` stages under `<repo>/.agentic-plugins/state/runtime/session-capture/note.json` (session-capture-contract.md §3.3): 4096 UTF-8-byte cap, atomic temp+rename, staging-time git context, `--file` restricted to a regular file (lstat no-follow — FIFO/device/symlink sources rejected). The explicit invocation is itself the ADR-0035 invariant-1 opt-in; the `session_capture` config gate governs only the S3b publisher, not explicit staging.
- Operator invocations of `note` and `status --slot` report on stdout and exit 1 on error. `--hook-grade` is reserved for hook/sidecar callers of `note`: exit 0 always, nothing on stdout, at most one stderr line, and a non-git cwd is a silent no-op.
- `status --slot` schema-validates each of slot.json/entry.json/note.json with per-file fail-closed skip, reports the generation verdict (committed / mixed / absent), and never repairs or deletes a file on read. Note and summary content are untrusted quoted data.
- Config-off persistence (session-capture-contract.md §9): `session_capture = "off"` stops production only — existing slot/entry/note artifacts remain on disk and readable; removing them is an operator action.
- Rolling-checkpoint limit (contract §1): abrupt host termination emits no final capture — the previous turn's slot IS the handoff; a session that never staged a note hands off a structural-only slot (`summary_source = structural`).
- Rollback order is consumer-first (contract §9): ADR-0045 entry surfaces (when they exist) → `session_capture = "off"` → attention sensor → runtime; the one-shot cleanup — removing `.agentic-plugins/state/runtime/session-capture/` from the intended repo root, after verifying `session_capture` is effectively off (irreversible; run it per repo) — prevents a stale staged note from resurfacing after a re-upgrade.
- Half-enabled chains (key on + attention missing/disabled, runtime below the dynamically-declared publisher floor, safe mode) are surfaced by `runtime:doctor` / `runtime:settings` readiness diagnosis (contract §13), not by this command.
- `entry-brief` requires an explicit `--host claude|codex` (trusted render host for command localization; no default) and takes no selector/staging/projection flags. It is R0 (reads only, consumes nothing); uncertainty above the would-be leader yields `indeterminate` with no command, unlinked peers yield `owner-choice-required`, detached HEAD yields `no-branch-context`, and a non-git cwd is an honest skip. The hook surface (`--surface session-start-hook`) exits 0 always and emits at most one marker-paired stdout line under the 4096-byte cap; the `entry_brief` gate binds only that surface, is user-scope-only (a tracked repo value is ignored and reported; the settings repo target refuses to write it), and resolves env (`AGENTIC_ENTRY_BRIEF`/`AGENTIC_ENTRY_BRIEF_EMPTY`) > user-global > default.
