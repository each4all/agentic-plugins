---
name: context
description: "Runtime-owned ADR-0024 context hygiene artifact scaffold and read-only budget check. Use when the user wants a bounded context summary, risk level, artifact pointers, recommended next-session prompt/action, or explicit context-budget status without mutating host session context."
---

# Context (runtime framework primitive)

`runtime:context` is the first ADR-0024 context hygiene scaffold. It writes runtime-owned artifacts for capture/status, offers a read-only explicit budget check, and keeps the main session output bounded.

## When invoked by command (`/runtime:context` or `$runtime:context`)

1. Resolve the plugin root.
   - Claude: `$CLAUDE_PLUGIN_ROOT` or the command file's plugin directory.
   - Codex: the installed skill directory's plugin root or the current repository checkout during development.
2. Run:

```bash
node "<runtime-plugin-root>/scripts/context.mjs" --repo-root "$REPO_ROOT" capture --summary <text> [--format text|json] [--risk green|yellow|red] [--risk-reason <text>] [--artifact kind:<repo-path>] [--next-action <text>] [--next-session-prompt <text>]
node "<runtime-plugin-root>/scripts/context.mjs" --repo-root "$REPO_ROOT" capture --summary-file <path> [--next-session-prompt-file <path>]
node "<runtime-plugin-root>/scripts/context.mjs" --repo-root "$REPO_ROOT" status --run-id <id>
node "<runtime-plugin-root>/scripts/context.mjs" --repo-root "$REPO_ROOT" check --token-budget <n> (--used-tokens <n>|--remaining-tokens <n>)
node "<runtime-plugin-root>/scripts/context.mjs" --repo-root "$REPO_ROOT" check --risk green|yellow|red [--risk-reason <text>]
```

3. Present only the returned context summary, risk level, artifact pointers, and recommended next-session prompt/action.
   - Do not paste raw peer outputs into the main session.
   - Use artifact paths under `.agentic-plugins/runs/context/<run-id>/`.
   - Treat the scaffold and budget check as advisory. They do not trim, rewrite, compact, or mutate host session context.

## Scope

Context reports and manages:

- bounded context summary artifacts;
- green/yellow/red context risk level;
- repo-local artifact pointers for readiness, consensus, workflow, or other handoff evidence;
- recommended next-session action;
- generated or caller-supplied next-session prompt artifact.
- read-only explicit context budget checks from caller-supplied token counts or caller-supplied risk.

## Boundaries

- No host session context mutation.
- No automatic compaction, host switch, or workflow start.
- No automatic context measurement, capture trigger, or new session start from `check`.
- No direct peer execution.
- No consensus raw output or peer raw output in the main session.
- No engineer/orchestrator workflow state migration.
- No host-native config, authentication, secret, sandbox, or permission writes.
- No claim that Codex manual-hook or permission limits are host parity.

## Example

```bash
$runtime:context capture --summary "Runtime context scaffold complete; tests pending." --risk yellow --next-action "Start a fresh session for the next runtime PR."
$runtime:context status --run-id context-YYYYMMDDTHHMMSSZ-abcdef
$runtime:context check --token-budget 100000 --remaining-tokens 12000
```
